import {
	ApplicationCommandData,
	ApplicationCommandOptionType,
	ApplicationCommandType,
	ChatInputCommandInteraction,
	ChannelType,
	GuildMember,
	PermissionsBitField,
} from 'discord.js';

import {logger, logError} from '../logger';
import {DDCommand} from './_commands';
import ServerSetting from '../database/models/server_setting.model';
import {isSnowflake} from '../utils/authz';

const allSettings = [
	{
		name: 'Channel for "New public Voicechannel"',
		value: 'NEW_PUBLIC_VOICECHANNEL',
	},
	{
		name: 'Channel for "New private Voicechannel"',
		value: 'NEW_PRIVATE_VOICECHANNEL',
	},
] as const;

export type SettingKey =
	(typeof allSettings)[number]['value'];

const SETTING_KEYS: readonly string[] = allSettings.map(
	(setting) => setting.value,
);

const isSettingKey = (value: unknown): value is SettingKey =>
	typeof value === 'string' && SETTING_KEYS.includes(value);

/**
 * Client-side `defaultMemberPermissions` is only a UI hint. Discord also
 * lets integrations invoke commands via API, and the permission set can be
 * changed after registration, so every handler re-checks server-side.
 */
const canManageSettings = (
	interaction: ChatInputCommandInteraction,
): boolean => {
	const member = interaction.member;
	if (!member || !(member instanceof GuildMember)) return false;
	return member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
		member.permissions.has(PermissionsBitField.Flags.Administrator);
};

const denyAccess = async (
	interaction: ChatInputCommandInteraction,
): Promise<void> => {
	if (interaction.replied || interaction.deferred) {
		await interaction.editReply({
			content:
				'คำสั่งนี้ต้องใช้สิทธิ์ จัดการเซิร์ฟเวอร์ (ManageGuild) ' +
				'หรือ Administrator',
		});
		return;
	}
	await interaction.reply({
		content:
			'คำสั่งนี้ต้องใช้สิทธิ์ จัดการเซิร์ฟเวอร์ (ManageGuild) ' +
			'หรือ Administrator',
		ephemeral: true,
	});
};

const requireGuildId = (
	interaction: ChatInputCommandInteraction,
): string | null => interaction.guildId;

export default {
	commandData: {
		type: ApplicationCommandType.ChatInput,
		name: 'settings',
		description: 'ดูและแก้ไขการตั้งค่าบอทในเซิร์ฟเวอร์นี้',
		dmPermission: false,
		defaultMemberPermissions: PermissionsBitField.Flags.ManageGuild,
		options: [
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: 'view',
				description: 'ดูการตั้งค่าทั้งหมดที่กำหนดไว้ในเซิร์ฟเวอร์นี้',
			},
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: 'get',
				description: 'ดูรายละเอียดของการตั้งค่าที่เลือก',
				options: [
					{
						type: ApplicationCommandOptionType.String,
						name: 'key',
						description: 'ชื่อการตั้งค่าที่ต้องการดู',
						required: true,
						choices: allSettings.map((setting) => ({
							name: setting.name,
							value: setting.value,
						})),
					},
				],
			},
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: 'set',
				description: 'กำหนดค่าการตั้งค่าที่เลือกในเซิร์ฟเวอร์นี้',
				options: [
					{
						type: ApplicationCommandOptionType.String,
						name: 'key',
						description: 'ชื่อการตั้งค่าที่ต้องการกำหนด',
						required: true,
						choices: allSettings.map((setting) => ({
							name: setting.name,
							value: setting.value,
						})),
					},
					{
						type: ApplicationCommandOptionType.String,
						name: 'value',
						description: 'ไอดีของช่องเสียงที่ต้องการบันทึก',
						required: true,
					},
				],
			},
		],
	} as ApplicationCommandData,

	commandExecutor: async (interaction: ChatInputCommandInteraction) => {
		if (interaction.commandName !== 'settings') {
			logger.error(
				`Interaction '${interaction.commandName}' was routed to the ` +
				'\'settings\' handler',
			);
			return;
		}

		// Authorization is checked before any reply or database write.
		if (!interaction.inGuild() || !canManageSettings(interaction)) {
			await denyAccess(interaction);
			return;
		}

		const guildId = requireGuildId(interaction);
		if (guildId === null) {
			if (!interaction.replied && !interaction.deferred) {
				await interaction.reply({
					content: 'คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์เท่านั้น',
					ephemeral: true,
				});
			}
			return;
		}

		const subcommand = interaction.options.getSubcommand(false);
		if (!subcommand || !['view', 'get', 'set'].includes(subcommand)) {
			await interaction.reply({
				content: 'ไม่รู้จักคำสั่งย่อยนี้',
				ephemeral: true,
			});
			return;
		}

		await interaction.deferReply({ephemeral: true});

		try {
			if (subcommand === 'view') {
				const rows = await ServerSetting.findAll({
					where: {guild_snowflake: guildId},
				});
				const lines = allSettings.map((setting) => {
					const row = rows.find(
						(entry) => entry.setting_name === setting.value,
					);
					return `• ${setting.name}: \`${row?.setting_value ?? 'ยังไม่ได้ตั้งค่า'}\``;
				});
				await interaction.editReply({
					content: lines.join('\n'),
				});
				return;
			}

			const rawKey = interaction.options.getString('key');
			if (!isSettingKey(rawKey)) {
				await interaction.editReply({
					content: 'การตั้งค่าที่ระบุไม่ถูกต้อง',
				});
				return;
			}

			if (subcommand === 'get') {
				const settingValue = await ServerSetting.findOne({
					where: {guild_snowflake: guildId, setting_name: rawKey},
				});
				await interaction.editReply({
					content: settingValue?.setting_value ??
						'ยังไม่ได้ตั้งค่ารายการนี้',
				});
				return;
			}

			// `set`: validate the target before writing. A raw string from a
			// slash command must be a snowflake of an existing voice channel
			// in this guild, otherwise the provisioning logic never fires and
			// the record points at somebody else's resource.
			const value = interaction.options.getString('value');
			if (!value || !isSnowflake(value)) {
				await interaction.editReply({
					content: 'ค่าที่ส่งมาต้องเป็นไอดีช่องเสียงที่ถูกต้อง',
				});
				return;
			}
			const targetChannel = await interaction.guild?.channels
				.fetch(value)
				.catch(() => null);
			if (
				!targetChannel ||
				targetChannel.type !== ChannelType.GuildVoice ||
				targetChannel.guildId !== guildId
			) {
				await interaction.editReply({
					content: 'ไม่พบช่องเสียงที่ระบุในเซิร์ฟเวอร์นี้',
				});
				return;
			}

			await ServerSetting.upsert({
				guild_snowflake: guildId,
				setting_name: rawKey,
				setting_value: value,
			});
			await interaction.editReply({content: 'บันทึกการตั้งค่าเรียบร้อยแล้ว'});
		} catch (err) {
			// Database/driver errors often carry connection strings. Log the
			// detail behind redaction and return a generic user-facing reply.
			logError('settings command failed', err);
			await interaction.editReply({
				content: 'เกิดข้อผิดพลาดขณะบันทึกการตั้งค่า กรุณาลองใหม่อีกครั้ง',
			});
		}
	},
} as DDCommand;
