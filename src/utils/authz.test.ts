import {
	ActorSnapshot,
	CHANNEL_EDIT_COOLDOWN_MS,
	DynamicChannelRecord,
	canApplyCooldown,
	canDeleteChannel,
	canInvite,
	canManageChannel,
	isSnowflake,
	remainingCooldownMs,
	validateChannelName,
} from './authz';

const record = (overrides: Partial<DynamicChannelRecord> = {}):
	DynamicChannelRecord => ({
	guild_snowflake: '111111111111111111',
	voice_channel_snowflake: '222222222222222222',
	text_channel_snowflake: '333333333333333333',
	positive_accessrole_snowflake: '444444444444444444',
	owner_member_snowflake: '555555555555555555',
	is_channel_private: false,
	is_channel_renamed: false,
	should_archive: false,
	inviteall_activated: false,
	last_edit: null,
	...overrides,
});

const actor = (overrides: Partial<ActorSnapshot> = {}): ActorSnapshot => ({
	memberId: '999999999999999999',
	roleIds: [],
	voiceChannelId: null,
	isAdministrator: false,
	hasManageGuild: false,
	isBot: false,
	...overrides,
});

describe('/voice close authorization', () => {
	it('rejects a connected non-owner without elevated permissions', () => {
		const decision = canDeleteChannel(
			record(),
			actor({voiceChannelId: '222222222222222222'}),
		);
		expect(decision).toEqual({allowed: false, reason: 'NOT_AUTHORIZED'});
	});

	it('allows the owner even when not connected to the voice channel', () => {
		expect(
			canDeleteChannel(record(), actor({memberId: '555555555555555555'}))
				.allowed,
		).toBe(true);
	});

	it('allows an explicit server administrator', () => {
		expect(
			canDeleteChannel(record(), actor({isAdministrator: true})).allowed,
		).toBe(true);
	});

	it('allows a member holding ManageGuild', () => {
		expect(
			canDeleteChannel(record(), actor({hasManageGuild: true})).allowed,
		).toBe(true);
	});

	it('never allows a bot actor', () => {
		expect(
			canDeleteChannel(
				record(),
				actor({isAdministrator: true, isBot: true}),
			).allowed,
		).toBe(false);
	});
});

describe('other handler boundaries', () => {
	it('keeps kick and transfer owner-only even for moderators', () => {
		const admin = actor({isAdministrator: true, hasManageGuild: true});
		expect(canManageChannel(record(), admin).reason).toBe('NOT_OWNER');
	});

	it('allows invites only via owner or inviteall plus channel membership', () => {
		const dyn = record({inviteall_activated: true});
		expect(canInvite(dyn, actor({voiceChannelId: '222222222222222222'})).allowed)
			.toBe(true);
		expect(canInvite(dyn, actor()).allowed).toBe(false);
		expect(canInvite(record(), actor({
			roleIds: ['444444444444444444'],
		})).allowed).toBe(false);
	});

	it('accepts only snowflake-shaped identifiers', () => {
		expect(isSnowflake('123456789012345678')).toBe(true);
		expect(isSnowflake('../../etc/passwd')).toBe(false);
		expect(isSnowflake('123')).toBe(false);
	});
});

describe('edit cooldown', () => {
	const now = 1_800_000_000_000;

	it('normalises a Date last_edit (regression: NaN disabled the cooldown)', () => {
		const dyn = record({last_edit: new Date(now - 60_000)});
		const remaining = remainingCooldownMs(dyn.last_edit, now);
		expect(remaining).toBe(CHANNEL_EDIT_COOLDOWN_MS - 60_000);
		expect(canApplyCooldown(dyn, now).reason).toBe('COOLDOWN_ACTIVE');
	});

	it('normalises a numeric epoch last_edit', () => {
		const dyn = record({last_edit: now - 60_000});
		expect(remainingCooldownMs(dyn.last_edit, now)).toBe(
			CHANNEL_EDIT_COOLDOWN_MS - 60_000,
		);
	});

	it('allows the edit once the window has elapsed', () => {
		const dyn = record({last_edit: new Date(now - CHANNEL_EDIT_COOLDOWN_MS)});
		expect(remainingCooldownMs(dyn.last_edit, now)).toBe(0);
		expect(canApplyCooldown(dyn, now).allowed).toBe(true);
	});

	it('allows rows with no recorded edit time', () => {
		expect(canApplyCooldown(record({last_edit: null}), now).allowed).toBe(true);
	});
});

describe('channel name validation', () => {
	it('rejects empty, overlong and control-character names', () => {
		expect(validateChannelName('   ').ok).toBe(false);
		expect(validateChannelName('x'.repeat(101)).ok).toBe(false);
		expect(validateChannelName('bad\u0000name').ok).toBe(false);
		expect(validateChannelName('bad@everyone').ok).toBe(false);
	});

	it('trims and accepts a normal name', () => {
		expect(validateChannelName('  lobby  ')).toEqual({
			ok: true,
			value: 'lobby',
		});
	});
});
