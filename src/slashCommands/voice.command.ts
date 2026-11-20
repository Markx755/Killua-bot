import {
	ApplicationCommandData,
	ApplicationCommandOptionType,
	ApplicationCommandType,
	ChannelType,
	ChatInputCommandInteraction,
	DiscordAPIError,
	EmbedBuilder,
	GuildMember,
	PermissionsBitField,
	TextChannel,
	VoiceChannel,
} from 'discord.js';

import {logger, logError} from '../logger';
import DynamicVoiceChannel from
	'../database/models/dynamic_voice_channel.model';
import {
	ActorSnapshot,
	Decision,
	canApplyCooldown,
	canDeleteChannel,
	canInvite,
	canManageChannel,
	canViewChannelInfo,
	isInChannel,
	validateChannelName,
} from '../utils/authz';
import {DDCommand} from './_commands';

const {ViewChannel} = PermissionsBitField.Flags;

/** Discord API error code for "Unknown Channel" / "Unknown Role". */
const UNKNOWN_RESOURCE_CODES = new Set([10003, 10011]);

const isGone = (err: unknown): boolean =>
	err instanceof DiscordAPIError && UNKNOWN_RESOURCE_CODES.has(Number(err.code));

const buildActor = (interaction: ChatInputCommandInteraction): ActorSnapshot => {
	const member = interaction.member as GuildMember;
	return {
		memberId: member.id,
		roleIds: [...member.roles.cache.keys()],
		voiceChannelId: member.voice?.channelId ?? null,
		isAdministrator: member.permissions.has(
			PermissionsBitField.Flags.Administrator,
		),
		hasManageGuild: member.permissions.has(
			PermissionsBitField.Flags.ManageGuild,
		),
		isBot: member.user.bot,
	};
};

/**
 * Resolves the dynamic channel a command targets. Only records belonging to
 * the guild the interaction arrived from are ever considered.
 */
const resolveDynamicChannel = async (
	interaction: ChatInputCommandInteraction,
): Promise<DynamicVoiceChannel | null> => {
	const guildId = interaction.guildId;
	if (guildId === null) return null;

	const byTextChannel = interaction.channelId ?
		await DynamicVoiceChannel.findOne({
			where: {
				guild_snowflake: guildId,
				text_channel_snowflake: interaction.channelId,
			},
		}) : null;
	if (byTextChannel) return byTextChannel;

	const member = interaction.member as GuildMember | null;
	const voiceChannelId = member?.voice?.channelId ?? null;
	if (voiceChannelId === null) return null;

	return DynamicVoiceChannel.findOne({
		where: {
			guild_snowflake: guildId,
			voice_channel_snowflake: voiceChannelId,
		},
	});
};

const denialMessage = (decision: Decision): string => {
	switch (decision.reason) {
	case 'NOT_OWNER':
		return 'คุณต้องเป็นเจ้าของห้องนี้เท่านั้นจึงจะทำรายการนี้ได้';
	case 'NOT_AUTHORIZED':
		return 'คุณไม่มีสิทธิ์ลบห้องนี้ (ต้องเป็นเจ้าของห้องหรือผู้ดูแลเซิร์ฟเวอร์)';
	case 'NOT_IN_CHANNEL':
		return 'คุณไม่ได้อยู่ในห้องเสียงนี้';
	case 'NO_ACCESS_ROLE':
		return 'คุณไม่มีสิทธิ์เข้าถึงห้องนี้';
	case 'COOLDOWN_ACTIVE': {
		const minutes = Math.max(
			1,
			Math.ceil((decision.retryAfterMs ?? 0) / 1000 / 60),
		);
		return `คุณต้องรออีกประมาณ ${minutes} นาทีจึงจะแก้ไขห้องนี้อีกครั้งได้`;
	}
	case 'TARGET_IS_SELF':
		return 'คุณไม่สามารถทำรายการนี้กับตัวเองได้';
	case 'TARGET_IS_BOT':
		return 'ไม่สามารถทำรายการนี้กับบอทได้';
	case 'INVALID_INPUT':
		return 'ข้อมูลที่ส่งมาไม่ถูกต้อง';
	default:
		return 'คุณไม่มีสิทธิ์ทำรายการนี้';
	}
};

const deny = async (
	interaction: ChatInputCommandInteraction,
	decision: Decision,
): Promise<void> => {
	await interaction.editReply({
		content: denialMessage(decision),
		allowedMentions: {parse: []},
	});
};

const fetchMemberOption = (
	interaction: ChatInputCommandInteraction,
): GuildMember | null => interaction.options.getMember('user') as
	GuildMember | null;

/**
 * Deletes the channel's resources and only then removes the database row.
 * A failed Discord API call leaves the record in place so a moderator can
 * retry instead of losing the only pointer to an orphaned channel.
 */
const closeDynamicChannel = async (
	interaction: ChatInputCommandInteraction,
	record: DynamicVoiceChannel,
): Promise<void> => {
	const guild = interaction.guild;
	if (!guild) return;

	const failures: string[] = [];

	const deleteVoice = async (): Promise<void> => {
		try {
			const channel = await guild.channels.fetch(
				record.voice_channel_snowflake,
			);
			if (channel) await channel.delete('Dynamic channel closed by owner');
		} catch (err) {
			if (!isGone(err)) failures.push('voice channel');
			logError('close: deleting voice channel failed', err);
		}
	};

	const handleText = async (): Promise<void> => {
		try {
			const textChannel = await guild.channels.fetch(
				record.text_channel_snowflake,
			);
			if (!textChannel) return;

			if (record.should_archive) {
				const owner = await guild.members
					.fetch(record.owner_member_snowflake)
					.catch(() => null);
				await textChannel.edit({
					name: `archived-by-${owner?.user.username ?? 'unknown'}`,
					permissionOverwrites: [
						{id: guild.roles.everyone.id, deny: [ViewChannel]},
						...(owner ?
							[{id: owner.id, allow: [ViewChannel]}] :
							[]),
					],
				});
			} else {
				await textChannel.delete('Dynamic channel closed by owner');
			}
		} catch (err) {
			if (!isGone(err)) failures.push('text channel');
			logError('close: handling text channel failed', err);
		}
	};

	const deleteRole = async (): Promise<void> => {
		try {
			const role = await guild.roles.fetch(
				record.positive_accessrole_snowflake,
			);
			if (role) await role.delete('Dynamic channel closed by owner');
		} catch (err) {
			if (!isGone(err)) failures.push('access role');
			logError('close: deleting access role failed', err);
		}
	};

	await deleteVoice();
	await handleText();
	await deleteRole();

	if (failures.length > 0) {
		await interaction.editReply({
			content:
				'ปิดห้องไม่สำเร็จทั้งหมด (ล้มเหลว: ' + failures.join(', ') +
				') — ข้อมูลห้องยังถูกเก็บไว้เพื่อให้ลองใหม่ได้',
		});
		return;
	}

	try {
		await record.destroy();
	} catch (err) {
		logError('close: removing database record failed', err);
		await interaction.editReply({
			content:
				'ลบช่องเรียบร้อยแล้ว แต่ลบข้อมูลในฐานข้อมูลไม่สำเร็จ ' +
				'กรุณาแจ้งผู้ดูแลระบบ',
		});
		return;
	}

	// The interaction lives in the channel that was just deleted, so a failed
	// edit here is expected and not an error worth surfacing.
	try {
		await interaction.editReply({content: 'ปิดและลบห้องเรียบร้อยแล้ว'});
	} catch {
		logger.debug('close: reply channel already deleted');
	}
};

const handlers: Record<string, (
	interaction: ChatInputCommandInteraction,
	record: DynamicVoiceChannel,
	actor: ActorSnapshot,
) => Promise<void>> = {
	invite: async (interaction, record, actor) => {
		const decision = canInvite(record, actor);
		if (!decision.allowed) {
			await deny(interaction, decision);
			return;
		}

		const invitedMember = fetchMemberOption(interaction);
		if (!invitedMember) {
			await interaction.editReply({
				content: 'ไม่พบสมาชิกที่ระบุในเซิร์ฟเวอร์นี้',
			});
			return;
		}
		if (invitedMember.id === actor.memberId) {
			await deny(interaction, {allowed: false, reason: 'TARGET_IS_SELF'});
			return;
		}
		if (invitedMember.user.bot) {
			await deny(interaction, {allowed: false, reason: 'TARGET_IS_BOT'});
			return;
		}

		try {
			const role = await interaction.guild?.roles.fetch(
				record.positive_accessrole_snowflake,
			);
			if (!role) {
				await interaction.editReply({
					content: 'ไม่พบยศสิทธิ์เข้าถึงของห้องนี้ กรุณาแจ้งผู้ดูแลระบบ',
				});
				return;
			}
			await invitedMember.roles.add(role);
			await interaction.editReply({
				content: `เชิญ ${invitedMember} เข้าห้องนี้เรียบร้อยแล้ว`,
				allowedMentions: {users: [invitedMember.id]},
			});
		} catch (err) {
			logError('invite failed', err);
			await interaction.editReply(
				`ไม่สามารถเชิญ ${invitedMember} เข้าห้องนี้ได้ ` +
				'||กรุณาแจ้งผู้ดูแลระบบหากยังเกิดปัญหาซ้ำ||',
			);
		}
	},

	kick: async (interaction, record, actor) => {
		const decision = canManageChannel(record, actor);
		if (!decision.allowed) {
			await deny(interaction, decision);
			return;
		}

		const kickedMember = fetchMemberOption(interaction);
		if (!kickedMember) {
			await interaction.editReply({
				content: 'ไม่พบสมาชิกที่ระบุในเซิร์ฟเวอร์นี้',
			});
			return;
		}
		if (kickedMember.id === actor.memberId) {
			await deny(interaction, {allowed: false, reason: 'TARGET_IS_SELF'});
			return;
		}
		if (kickedMember.id === record.owner_member_snowflake) {
			await interaction.editReply({
				content: 'ไม่สามารถนำเจ้าของห้องออกจากห้องของตัวเองได้',
			});
			return;
		}

		const targetInChannel = isInChannel(record, {
			voiceChannelId: kickedMember.voice?.channelId ?? null,
		}) ||
			kickedMember.roles.cache.has(record.positive_accessrole_snowflake);
		if (!targetInChannel) {
			await interaction.editReply({
				content: `${kickedMember} ไม่ได้อยู่ในห้องนี้`,
			});
			return;
		}

		try {
			const role = await interaction.guild?.roles.fetch(
				record.positive_accessrole_snowflake,
			);
			if (role) await kickedMember.roles.remove(role);
			if (kickedMember.voice.channelId) {
				await kickedMember.voice.disconnect();
			}
			const extraText = record.is_channel_private ? '!' :
				' แต่สมาชิกคนนี้สามารถกลับเข้ามาได้เพราะห้องเป็นแบบสาธารณะ';
			await interaction.editReply({
				content: `นำ ${kickedMember} ออกจากห้องเรียบร้อยแล้ว${extraText}`,
			});
		} catch (err) {
			logError('kick failed', err);
			await interaction.editReply(
				`ไม่สามารถนำ ${kickedMember} ออกจากห้องนี้ได้ ` +
				'||กรุณาแจ้งผู้ดูแลระบบหากยังเกิดปัญหาซ้ำ||',
			);
		}
	},

	transfer: async (interaction, record, actor) => {
		const decision = canManageChannel(record, actor);
		if (!decision.allowed) {
			await deny(interaction, decision);
			return;
		}

		const transferredMember = fetchMemberOption(interaction);
		if (!transferredMember) {
			await interaction.editReply({
				content: 'ไม่พบสมาชิกที่ระบุในเซิร์ฟเวอร์นี้',
			});
			return;
		}
		if (transferredMember.id === actor.memberId) {
			await deny(interaction, {allowed: false, reason: 'TARGET_IS_SELF'});
			return;
		}
		if (transferredMember.user.bot) {
			await deny(interaction, {allowed: false, reason: 'TARGET_IS_BOT'});
			return;
		}

		const memberInChannel = isInChannel(record, {
			voiceChannelId: transferredMember.voice?.channelId ?? null,
		});
		if (!memberInChannel) {
			await interaction.editReply({
				content: `${transferredMember} ไม่ได้เชื่อมต่ออยู่ในห้องนี้`,
			});
			return;
		}

		try {
			await record.update({
				owner_member_snowflake: transferredMember.id,
			});
			await interaction.editReply({
				content: `โอนความเป็นเจ้าของห้องให้ ${transferredMember} เรียบร้อยแล้ว`,
			});
		} catch (err) {
			logError('transfer failed', err);
			await interaction.editReply({
				content:
					'ไม่สามารถโอนความเป็นเจ้าของห้องได้ ' +
					'||กรุณาแจ้งผู้ดูแลระบบหากยังเกิดปัญหาซ้ำ||',
			});
		}
	},

	rename: async (interaction, record, actor) => {
		const decision = canManageChannel(record, actor);
		if (!decision.allowed) {
			await deny(interaction, decision);
			return;
		}

		const cooldown = canApplyCooldown(record);
		if (!cooldown.allowed) {
			await deny(interaction, cooldown);
			return;
		}

		const validation = validateChannelName(
			interaction.options.getString('name'),
		);
		if (validation.ok === false) {
			await interaction.editReply({content: validation.reason});
			return;
		}
		const newName = validation.value;

		try {
			const voiceChannel = await interaction.guild?.channels.fetch(
				record.voice_channel_snowflake,
			);
			const textChannel = await interaction.guild?.channels.fetch(
				record.text_channel_snowflake,
			);
			const role = await interaction.guild?.roles.fetch(
				record.positive_accessrole_snowflake,
			);
			if (role) await role.setName(newName);
			if (voiceChannel && voiceChannel.type === ChannelType.GuildVoice) {
				await voiceChannel.setName(newName);
			}
			if (textChannel && textChannel.type === ChannelType.GuildText) {
				await textChannel.setName(newName);
			}
			await record.update({
				last_edit: new Date(),
				is_channel_renamed: true,
			});
			await interaction.editReply({
				content: `เปลี่ยนชื่อห้องเป็น \`${newName}\` เรียบร้อยแล้ว`,
			});
		} catch (err) {
			logError('rename failed', err);
			await interaction.editReply({
				content:
					'ไม่สามารถเปลี่ยนชื่อห้องได้ ' +
					'||กรุณาแจ้งผู้ดูแลระบบหากยังเกิดปัญหาซ้ำ||',
			});
		}
	},

	togglevisibility: async (interaction, record, actor) => {
		const decision = canManageChannel(record, actor);
		if (!decision.allowed) {
			await deny(interaction, decision);
			return;
		}

		const cooldown = canApplyCooldown(record);
		if (!cooldown.allowed) {
			await deny(interaction, cooldown);
			return;
		}

		const guild = interaction.guild;
		if (!guild) return;

		try {
			const role = await guild.roles.fetch(
				record.positive_accessrole_snowflake,
			);
			const voiceChannel = await guild.channels.fetch(
				record.voice_channel_snowflake,
			);
			const textChannel = await guild.channels.fetch(
				record.text_channel_snowflake,
			);

			if (!role || !voiceChannel || !textChannel) {
				await interaction.editReply({
					content: 'ไม่พบช่องหรือยศของห้องนี้ในเซิร์ฟเวอร์ ' +
						'(ใช้ /voice close เพื่อล้างข้อมูลห้อง)',
				});
				return;
			}

			const goingPrivate = !record.is_channel_private;
			const prefix = goingPrivate ? 'Private by' : 'Public by';
			const newName = record.is_channel_renamed ?
				undefined :
				`${prefix} ${interaction.member?.user.username ?? 'unknown'}`;

			// Permissions are re-applied explicitly for both channels; the old
			// code left `lockPermissions()` un-awaited, so a visibility flip
			// could race against the overwrites that followed it.
			const applicableChannels = [voiceChannel, textChannel].filter(
				(channel): channel is TextChannel | VoiceChannel =>
					channel.type === ChannelType.GuildText ||
					channel.type === ChannelType.GuildVoice,
			);

			for (const channel of applicableChannels) {
				if (newName) await channel.setName(newName);
				await channel.lockPermissions();
				await channel.permissionOverwrites.edit(
					interaction.client.user,
					{ViewChannel: true},
				);
				await channel.permissionOverwrites.edit(guild.roles.everyone, {
					ViewChannel: !goingPrivate,
				});
				await channel.permissionOverwrites.edit(role, {ViewChannel: true});
			}

			if (newName) await role.setName(newName);

			await record.update({
				last_edit: new Date(),
				is_channel_private: goingPrivate,
			});

			await interaction.editReply({
				content: goingPrivate ?
					'ตั้งค่าห้องเป็นแบบส่วนตัวเรียบร้อยแล้ว' :
					'ตั้งค่าห้องเป็นแบบสาธารณะเรียบร้อยแล้ว',
			});
		} catch (err) {
			logError('togglevisibility failed', err);
			await interaction.editReply({
				content:
					'ไม่สามารถเปลี่ยนการมองเห็นของห้องได้ ' +
					'||กรุณาแจ้งผู้ดูแลระบบหากยังเกิดปัญหาซ้ำ||',
			});
		}
	},

	inviteall: async (interaction, record, actor) => {
		const decision = canManageChannel(record, actor);
		if (!decision.allowed) {
			await deny(interaction, decision);
			return;
		}
		await record.update({inviteall_activated: !record.inviteall_activated});
		await interaction.editReply({
			content: record.inviteall_activated ?
				'อนุญาตให้สมาชิกทุกคนในห้องเชิญสมาชิกใหม่ได้แล้ว' :
				'ตอนนี้เฉพาะเจ้าของห้องเท่านั้นที่เชิญสมาชิกใหม่ได้',
		});
	},

	archive: async (interaction, record, actor) => {
		const decision = canManageChannel(record, actor);
		if (!decision.allowed) {
			await deny(interaction, decision);
			return;
		}
		await record.update({should_archive: !record.should_archive});
		await interaction.editReply({
			content: record.should_archive ?
				'ห้องนี้จะถูกเก็บถาวร (archive) เมื่อปิดห้อง' :
				'ห้องนี้จะไม่ถูกเก็บถาวรเมื่อปิดห้อง',
		});
	},

	info: async (interaction, record, actor) => {
		const decision = canViewChannelInfo(record, actor);
		if (!decision.allowed) {
			await deny(interaction, decision);
			return;
		}

		try {
			const voiceChannel = await interaction.guild?.channels.fetch(
				record.voice_channel_snowflake,
			);
			const textChannel = await interaction.guild?.channels.fetch(
				record.text_channel_snowflake,
			);
			const owner = await interaction.guild?.members
				.fetch(record.owner_member_snowflake)
				.catch(() => null);
			const role = await interaction.guild?.roles.fetch(
				record.positive_accessrole_snowflake,
			);

			const infoEmbed = new EmbedBuilder()
				.setColor('#0099ff')
				.setTitle(voiceChannel?.name ?? 'ไม่พบชื่อห้อง')
				.setDescription('ข้อมูลของห้องเสียงไดนามิกนี้')
				.addFields(
					{name: 'เจ้าของห้อง', value: `${owner?.user ?? 'ไม่ทราบ'}`, inline: true},
					{name: 'ช่องเสียง', value: `${voiceChannel ?? 'ไม่พบ'}`, inline: true},
					{name: 'ช่องข้อความ', value: `${textChannel ?? 'ไม่พบ'}`, inline: true},
					{name: 'ยศสิทธิ์เข้าถึง', value: `${role ?? 'ไม่พบ'}`, inline: true},
					{
						name: 'การมองเห็น',
						value: record.is_channel_private ? '🔒 ส่วนตัว' : '🔓 สาธารณะ',
						inline: true,
					},
					{
						name: 'inviteall',
						value: record.inviteall_activated ? '✅ เปิด' : '❌ ปิด',
						inline: true,
					},
					{
						name: 'archive',
						value: record.should_archive ? '✅ เปิด' : '❌ ปิด',
						inline: true,
					},
				);
			await interaction.editReply({embeds: [infoEmbed]});
		} catch (err) {
			logError('info failed', err);
			await interaction.editReply({
				content:
					'ไม่สามารถดึงข้อมูลห้องได้ ' +
					'||กรุณาแจ้งผู้ดูแลระบบหากยังเกิดปัญหาซ้ำ||',
			});
		}
	},

	close: async (interaction, record, actor) => {
		// Authorization happens before any destructive call: owner, server
		// administrator, or a member with ManageGuild only.
		const decision = canDeleteChannel(record, actor);
		if (!decision.allowed) {
			await deny(interaction, decision);
			return;
		}
		await closeDynamicChannel(interaction, record);
	},
};

export default {
	commandData: {
		type: ApplicationCommandType.ChatInput,
		name: 'voice',
		description: 'จัดการห้องเสียงไดนามิกที่คุณเป็นเจ้าของหรือกำลังใช้งาน',
		dmPermission: false,
		options: [
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: 'invite',
				description: 'เชิญสมาชิกเข้าห้อง',
				options: [
					{
						type: ApplicationCommandOptionType.User,
						name: 'user',
						description: 'สมาชิกที่ต้องการเชิญเข้าห้อง',
						required: true,
					},
				],
			},
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: 'kick',
				description: 'นำสมาชิกออกจากห้อง',
				options: [
					{
						type: ApplicationCommandOptionType.User,
						name: 'user',
						description: 'สมาชิกที่ต้องการนำออกจากห้อง',
						required: true,
					},
				],
			},
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: 'transfer',
				description: 'โอนความเป็นเจ้าของห้องให้สมาชิกคนอื่น',
				options: [
					{
						type: ApplicationCommandOptionType.User,
						name: 'user',
						description: 'สมาชิกที่จะได้รับความเป็นเจ้าของห้อง',
						required: true,
					},
				],
			},
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: 'rename',
				description: 'เปลี่ยนชื่อห้อง',
				options: [
					{
						type: ApplicationCommandOptionType.String,
						name: 'name',
						description: 'ชื่อใหม่ของห้อง',
						maxLength: 100,
						required: true,
					},
				],
			},
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: 'togglevisibility',
				description: 'สลับการมองเห็นห้องระหว่างสาธารณะและส่วนตัว',
			},
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: 'inviteall',
				description: 'อนุญาตให้สมาชิกทุกคนที่อยู่ในห้องเชิญสมาชิกใหม่ได้',
			},
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: 'archive',
				description: 'เมื่อปิดห้อง ช่องข้อความจะไม่ถูกลบแต่ถูกเก็บถาวร',
			},
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: 'info',
				description: 'ดูข้อมูลห้องเสียงที่คุณกำลังใช้งาน',
			},
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: 'close',
				description: 'ปิดและลบห้องเสียงของคุณ (เจ้าของห้องหรือผู้ดูแลเท่านั้น)',
			},
		],
	} as ApplicationCommandData,

	commandExecutor: async (interaction: ChatInputCommandInteraction) => {
		if (interaction.commandName !== 'voice') {
			logger.error(
				`Interaction '${interaction.commandName}' was routed to the ` +
				'\'voice\' handler',
			);
			return;
		}

		// Guild context is mandatory: every record lookup is guild-scoped.
		if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
			await interaction.reply({
				content: 'คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์เท่านั้น',
				ephemeral: true,
			});
			return;
		}

		const subcommand = interaction.options.getSubcommand(false);
		if (!subcommand || !handlers[subcommand]) {
			await interaction.reply({
				content: 'ไม่รู้จักคำสั่งย่อยนี้',
				ephemeral: true,
			});
			return;
		}

		await interaction.deferReply({ephemeral: false});

		const record = await resolveDynamicChannel(interaction);
		if (!record) {
			await interaction.editReply({
				content: 'คุณไม่ได้เชื่อมต่ออยู่กับห้องเสียงไดนามิกใด',
			});
			return;
		}
		if (record.guild_snowflake !== interaction.guildId) {
			logger.warn(
				`Rejected cross-guild channel access: record ${record.guild_snowflake}`,
			);
			await interaction.editReply({
				content: 'ไม่พบข้อมูลห้องที่ตรงกับเซิร์ฟเวอร์นี้',
			});
			return;
		}

		const actor = buildActor(interaction);
		await handlers[subcommand](interaction, record, actor);
	},
} as DDCommand;
