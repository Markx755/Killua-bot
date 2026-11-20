/**
 * Authorization and input-validation primitives.
 *
 * Everything in this module is pure: it takes a snapshot of the acting member
 * and the database record and returns a decision. Kept free of discord.js
 * runtime objects so the rules can be unit tested and so no handler can
 * accidentally rely on a cached discord.js permission state.
 */

/** Edit cooldown for owner-driven channel mutations (rename / visibility). */
export const CHANNEL_EDIT_COOLDOWN_MS = 10 * 60 * 1000;

export const MAX_CHANNEL_NAME_LENGTH = 100;

export interface DynamicChannelRecord {
	guild_snowflake: string;
	voice_channel_snowflake: string;
	text_channel_snowflake: string;
	positive_accessrole_snowflake: string;
	owner_member_snowflake: string;
	is_channel_private: boolean;
	is_channel_renamed: boolean;
	should_archive: boolean;
	inviteall_activated: boolean;
	last_edit: Date | number | string | null;
}

export interface ActorSnapshot {
	/** Discord snowflake of the acting member. */
	memberId: string;
	/** Role snowflakes the acting member currently holds. */
	roleIds: readonly string[];
	/** Voice channel the acting member is connected to, if any. */
	voiceChannelId: string | null;
	/** Discord `Administrator` permission. */
	isAdministrator: boolean;
	/** Discord `ManageGuild` permission. */
	hasManageGuild: boolean;
	/** True when the actor is a bot account. */
	isBot: boolean;
}

export type DenialReason =
	| 'NOT_A_MEMBER'
	| 'WRONG_GUILD'
	| 'NOT_OWNER'
	| 'NOT_AUTHORIZED'
	| 'NOT_IN_CHANNEL'
	| 'NO_ACCESS_ROLE'
	| 'COOLDOWN_ACTIVE'
	| 'TARGET_IS_SELF'
	| 'TARGET_IS_BOT'
	| 'INVALID_INPUT';

export interface Decision {
	allowed: boolean;
	reason?: DenialReason;
	/** Milliseconds the caller must still wait, when reason is COOLDOWN_ACTIVE. */
	retryAfterMs?: number;
}

const allow = (): Decision => ({allowed: true});

const deny = (reason: DenialReason, retryAfterMs?: number): Decision => ({
	allowed: false,
	reason,
	retryAfterMs,
});

export const isSnowflake = (value: unknown): value is string =>
	typeof value === 'string' && /^\d{15,25}$/.test(value);

export const isChannelOwner = (
	record: Pick<DynamicChannelRecord, 'owner_member_snowflake'>,
	actor: Pick<ActorSnapshot, 'memberId'>,
): boolean => record.owner_member_snowflake === actor.memberId;

export const isInChannel = (
	record: Pick<DynamicChannelRecord, 'voice_channel_snowflake'>,
	actor: Pick<ActorSnapshot, 'voiceChannelId'>,
): boolean =>
	actor.voiceChannelId !== null &&
	actor.voiceChannelId === record.voice_channel_snowflake;

export const hasAccessRole = (
	record: Pick<DynamicChannelRecord, 'positive_accessrole_snowflake'>,
	actor: Pick<ActorSnapshot, 'roleIds'>,
): boolean => actor.roleIds.includes(record.positive_accessrole_snowflake);

/**
 * True when the record belongs to the guild the interaction came from.
 * Guards every query path against cross-guild identifier smuggling.
 */
export const belongsToGuild = (
	record: Pick<DynamicChannelRecord, 'guild_snowflake'>,
	guildId: string | null,
): boolean => guildId !== null && record.guild_snowflake === guildId;

/**
 * Invite rule: the owner may always invite; everyone else only when the
 * channel enabled `inviteall` AND the actor is actually inside the channel
 * (access role or connected to the voice channel).
 */
export const canInvite = (
	record: DynamicChannelRecord,
	actor: ActorSnapshot,
): Decision => {
	if (actor.isBot) return deny('TARGET_IS_BOT');
	if (isChannelOwner(record, actor)) return allow();
	if (!record.inviteall_activated) return deny('NOT_OWNER');
	if (hasAccessRole(record, actor) || isInChannel(record, actor)) return allow();
	return deny('NO_ACCESS_ROLE');
};

/**
 * Destructive operations (`close`) are limited to the owner and to members
 * explicitly holding server-level moderator permissions.
 */
export const canDeleteChannel = (
	record: DynamicChannelRecord,
	actor: ActorSnapshot,
): Decision => {
	if (actor.isBot) return deny('TARGET_IS_BOT');
	if (isChannelOwner(record, actor)) return allow();
	if (actor.isAdministrator || actor.hasManageGuild) return allow();
	return deny('NOT_AUTHORIZED');
};

/** Membership check used by the read-only `info` subcommand. */
export const canViewChannelInfo = (
	record: DynamicChannelRecord,
	actor: ActorSnapshot,
): Decision => {
	if (isChannelOwner(record, actor)) return allow();
	if (actor.isAdministrator || actor.hasManageGuild) return allow();
	if (hasAccessRole(record, actor) || isInChannel(record, actor)) return allow();
	return deny('NO_ACCESS_ROLE');
};

/** Owner-only mutations: kick, transfer, rename, visibility, options. */
export const canManageChannel = (
	record: DynamicChannelRecord,
	actor: ActorSnapshot,
): Decision => {
	if (actor.isBot) return deny('TARGET_IS_BOT');
	if (isChannelOwner(record, actor)) return allow();
	return deny('NOT_OWNER');
};

/**
 * `last_edit` comes back from Sequelize as a Date, but older rows may hold a
 * numeric epoch. Both are normalised here — the previous implementation
 * subtracted a Date from Date.now() and silently produced NaN, which made the
 * cooldown always pass.
 */
export const toEpochMs = (value: DynamicChannelRecord['last_edit']): number => {
	if (value === null || value === undefined) return 0;
	if (value instanceof Date) {
		const time = value.getTime();
		return Number.isFinite(time) ? time : 0;
	}
	if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
};

export const remainingCooldownMs = (
	lastEdit: DynamicChannelRecord['last_edit'],
	nowMs: number = Date.now(),
	cooldownMs: number = CHANNEL_EDIT_COOLDOWN_MS,
): number => {
	const last = toEpochMs(lastEdit);
	if (last === 0) return 0;
	const elapsed = nowMs - last;
	if (!Number.isFinite(elapsed) || elapsed >= cooldownMs) return 0;
	return cooldownMs - elapsed;
};

export const canApplyCooldown = (
	record: DynamicChannelRecord,
	nowMs: number = Date.now(),
): Decision => {
	const remaining = remainingCooldownMs(record.last_edit, nowMs);
	if (remaining > 0) return deny('COOLDOWN_ACTIVE', remaining);
	return allow();
};

/**
 * Channel names are re-used for the voice channel, the text channel and the
 * access role, so a single validator covers all three. Rejects empty,
 * whitespace-only, over-long and control-character input.
 */
export const validateChannelName = (
	name: unknown,
): {ok: true; value: string} | {ok: false; reason: string} => {
	if (typeof name !== 'string') {
		return {ok: false, reason: 'Name must be a string.'};
	}
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		return {ok: false, reason: 'Name must not be empty.'};
	}
	if (trimmed.length > MAX_CHANNEL_NAME_LENGTH) {
		return {
			ok: false,
			reason: `Name must be at most ${MAX_CHANNEL_NAME_LENGTH} characters.`,
		};
	}
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
		return {ok: false, reason: 'Name must not contain control characters.'};
	}
	if (/[@#:`]/.test(trimmed)) {
		return {
			ok: false,
			reason: 'Name must not contain @, #, : or ` characters.',
		};
	}
	return {ok: true, value: trimmed};
};
