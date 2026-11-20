import {
	ChannelType,
	Client,
	GatewayIntentBits,
	Guild,
	Interaction,
	InteractionType,
	PermissionsBitField,
	VoiceState,
} from 'discord.js';
import dotenv from 'dotenv';
import {Sequelize} from 'sequelize-typescript';

import {AppConfig, loadConfig} from './config';
import {
	closeDatabase,
	connectDatabase,
	createSequelize,
} from './database/dbmanager';
import DynamicVoiceChannel from './database/models/dynamic_voice_channel.model';
import ServerSetting from './database/models/server_setting.model';
import {logError, logger} from './logger';
import srcCommands from './slashCommands/_commands';

dotenv.config();

const {ViewChannel} = PermissionsBitField.Flags;

/**
 * Resources created while provisioning a dynamic channel. Tracked as they are
 * created so a failure half-way through can be rolled back; the previous code
 * only cleaned up from the database row, which did not exist yet when role or
 * channel creation failed, leaving orphaned roles and channels behind.
 */
interface ProvisionedResources {
	roleIds: string[];
	channelIds: string[];
}

const newTracker = (): ProvisionedResources => ({roleIds: [], channelIds: []});

const rollbackResources = async (
	guild: Guild,
	created: ProvisionedResources,
): Promise<void> => {
	const channelFailure = 'Dynamic channel provisioning rollback failed';

	for (const channelId of [...created.channelIds].reverse()) {
		try {
			const channel = await guild.channels.fetch(channelId);
			if (channel) await channel.delete('Rollback of failed channel creation');
		} catch (err) {
			logError(`${channelFailure} (channel ${channelId})`, err);
		}
	}
	for (const roleId of [...created.roleIds].reverse()) {
		try {
			const role = await guild.roles.fetch(roleId);
			if (role) await role.delete('Rollback of failed channel creation');
		} catch (err) {
			logError(`${channelFailure} (role ${roleId})`, err);
		}
	}
};

const createClient = (): Client => new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildVoiceStates,
	],
});

/**
 * Registers the slash command tree and removes commands that no longer exist
 * in source. Awaited sequentially: the previous `forEach(async ...)` version
 * returned before any API call resolved, so startup reported success while
 * registration was still in flight (and any rejection was unhandled).
 */
const syncApplicationCommands = async (client: Client): Promise<void> => {
	if (!client.application) {
		throw new Error('Discord application is not available before login.');
	}

	logger.info('Updating command registry via Discord API...');
	const appCommands = await client.application.commands.fetch();

	for (const appCommand of appCommands.values()) {
		const srcCommand = srcCommands.find(
			(src) => src.commandData.name === appCommand.name,
		);
		if (!srcCommand) {
			logger.debug(
				`APP ${appCommand.name} is ${appCommand.id} -> no longer in source ` +
				'-> deleting',
			);
			await appCommand.delete();
		}
	}

	for (const srcCommand of srcCommands) {
		const appCommand = appCommands.find(
			(app) => app.name === srcCommand.commandData.name,
		);
		if (!appCommand) {
			logger.debug(
				`SRC ${srcCommand.commandData.name} is nonexistent -> creating`,
			);
			await client.application.commands.create(srcCommand.commandData);
			continue;
		}
		if (appCommand.equals(srcCommand.commandData)) {
			logger.debug(
				`SRC ${srcCommand.commandData.name} is ${appCommand.id} -> ` +
				'no changes needed',
			);
			continue;
		}
		logger.debug(
			`SRC ${srcCommand.commandData.name} is ${appCommand.id} -> re-syncing`,
		);
		await appCommand.edit(srcCommand.commandData);
	}

	logger.info('Command registry updated successfully.');
};

const createDynamicChannel = async (
	state: VoiceState,
	isPrivate: boolean,
): Promise<void> => {
	const member = state.member;
	const guild = state.guild;
	if (!member) {
		logError('createDynamicChannel', new Error('Voice state has no member'));
		return;
	}

	const label = isPrivate ? 'Private' : 'Public';
	const channelName = `${label} by ${member.user.username}`;
	const botMember = guild.members.me;
	if (!botMember) {
		logError(
			'createDynamicChannel',
			new Error('Bot member is not resolvable in this guild'),
		);
		return;
	}

	const created = newTracker();
	let record: DynamicVoiceChannel | undefined;

	try {
		const role = await guild.roles.create({
			name: channelName,
			mentionable: false,
		});
		created.roleIds.push(role.id);

		const voiceChannel = await guild.channels.create({
			name: channelName,
			parent: state.channel?.parent ?? null,
			type: ChannelType.GuildVoice,
		});
		created.channelIds.push(voiceChannel.id);

		await voiceChannel.lockPermissions();
		await voiceChannel.permissionOverwrites.edit(botMember, {
			ViewChannel: true,
		});
		if (isPrivate) {
			await voiceChannel.permissionOverwrites.edit(guild.roles.everyone, {
				ViewChannel: false,
			});
			await voiceChannel.permissionOverwrites.edit(role, {
				ViewChannel: true,
			});
		}

		const textChannel = await guild.channels.create({
			name: channelName,
			parent: state.channel?.parent ?? null,
			type: ChannelType.GuildText,
		});
		created.channelIds.push(textChannel.id);

		await textChannel.lockPermissions();
		await textChannel.permissionOverwrites.edit(botMember, {
			ViewChannel: true,
		});
		await textChannel.permissionOverwrites.edit(guild.roles.everyone, {
			ViewChannel: false,
		});
		await textChannel.permissionOverwrites.edit(role, {
			ViewChannel: true,
		});

		record = await DynamicVoiceChannel.create({
			guild_snowflake: guild.id,
			voice_channel_snowflake: voiceChannel.id,
			text_channel_snowflake: textChannel.id,
			positive_accessrole_snowflake: role.id,
			owner_member_snowflake: member.id,
			is_channel_private: isPrivate,
			is_channel_renamed: false,
			last_edit: new Date(Date.now() - 600000),
			should_archive: false,
			inviteall_activated: false,
		});

		await member.voice.setChannel(voiceChannel);
		await member.roles.add(role);
	} catch (err) {
		logError(`Provisioning ${label.toLowerCase()} channel failed`, err);
		await rollbackResources(guild, created);
		if (record) {
			try {
				await record.destroy();
			} catch (dbErr) {
				logError('Failed to remove dangling channel record', dbErr);
			}
		}
	}
};

const findDynamicChannelFor = async (
	state: VoiceState,
): Promise<DynamicVoiceChannel | null> => {
	if (!state.channel) return null;
	return DynamicVoiceChannel.findOne({
		where: {
			guild_snowflake: state.guild.id,
			voice_channel_snowflake: state.channel.id,
		},
	});
};

const registerHandlers = (client: Client, sequelize: Sequelize): void => {
	client.once('ready', async () => {
		try {
			await syncApplicationCommands(client);
			logger.info(`Logged in as ${client.user?.tag ?? 'unknown user'}`);
		} catch (err) {
			logError('Initialisation after login failed', err);
			await shutdown(client, sequelize, 1);
		}
	});

	client.on('interactionCreate', async (interaction: Interaction) => {
		if (interaction.type !== InteractionType.ApplicationCommand) return;
		if (!interaction.isChatInputCommand()) return;

		const command = srcCommands.find(
			(src) => src.commandData.name === interaction.commandName,
		);
		if (!command) {
			logger.warn(`No handler registered for /${interaction.commandName}`);
			return;
		}

		try {
			await command.commandExecutor(interaction);
		} catch (err) {
			logError(`Handler for /${interaction.commandName} threw`, err);
			try {
				if (interaction.deferred || interaction.replied) {
					await interaction.editReply({
						content: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง',
					});
				} else {
					await interaction.reply({
						content: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง',
						ephemeral: true,
					});
				}
			} catch (replyErr) {
				logError('Failed to report handler failure', replyErr);
			}
		}
	});

	client.on('dynamicChannelJoin', async (
		state: VoiceState,
		dynamicChannel: DynamicVoiceChannel,
	) => {
		const member = state.member;
		if (!member) return;
		try {
			const role = await state.guild.roles.fetch(
				dynamicChannel.positive_accessrole_snowflake,
			);
			if (!role) {
				logger.warn(
					`Access role ${dynamicChannel.positive_accessrole_snowflake} is gone`,
				);
				return;
			}
			await member.roles.add(role);
		} catch (err) {
			logError('Failed to grant dynamic channel access role', err);
		}
	});

	client.on('voiceChannelJoin', async (
		state: VoiceState,
		dynamicChannel: DynamicVoiceChannel | null,
	) => {
		try {
			if (dynamicChannel) {
				client.emit('dynamicChannelJoin', state, dynamicChannel);
				return;
			}

			if (!state.channel) return;

			const publicSetting = await ServerSetting.findOne({
				where: {
					guild_snowflake: state.guild.id,
					setting_name: 'NEW_PUBLIC_VOICECHANNEL',
				},
			});
			if (publicSetting && state.channel.id === publicSetting.setting_value) {
				await createDynamicChannel(state, false);
				return;
			}

			const privateSetting = await ServerSetting.findOne({
				where: {
					guild_snowflake: state.guild.id,
					setting_name: 'NEW_PRIVATE_VOICECHANNEL',
				},
			});
			if (privateSetting && state.channel.id === privateSetting.setting_value) {
				await createDynamicChannel(state, true);
			}
		} catch (err) {
			logError('voiceChannelJoin handler failed', err);
		}
	});

	client.on('dynamicChannelLeave', async (
		state: VoiceState,
		dynamicChannel: DynamicVoiceChannel,
	) => {
		const member = state.member;
		try {
			if (!dynamicChannel.is_channel_private && member) {
				const role = await state.guild.roles.fetch(
					dynamicChannel.positive_accessrole_snowflake,
				);
				if (role) await member.roles.remove(role);
			}
		} catch (err) {
			logError('Failed to remove access role on leave', err);
		}

		try {
			const voiceChannel = state.channel;
			if (!voiceChannel) return;
			if (voiceChannel.members.size > 0) return;

			const role = await state.guild.roles.fetch(
				dynamicChannel.positive_accessrole_snowflake,
			);
			if (role) await role.delete('Corresponding voice channel is empty');

			const textChannel = await state.guild.channels.fetch(
				dynamicChannel.text_channel_snowflake,
			);

			if (dynamicChannel.should_archive && textChannel) {
				const owner = await state.guild.members.fetch(
					dynamicChannel.owner_member_snowflake,
				);
				await textChannel.edit({
					name: `archived-by-${owner.user.username}`,
					permissionOverwrites: [
						{
							id: state.guild.roles.everyone.id,
							deny: [ViewChannel],
						},
						{id: owner.id, allow: [ViewChannel]},
					],
				});
			} else if (textChannel) {
				await textChannel.delete('Corresponding voice channel is empty');
			}

			await voiceChannel.delete('This voice channel is empty');
			await dynamicChannel.destroy();
		} catch (err) {
			logError('Failed to tear down empty dynamic channel', err);
		}
	});

	client.on('voiceChannelLeave', (
		state: VoiceState,
		dynamicChannel: DynamicVoiceChannel | null,
	) => {
		if (dynamicChannel) {
			client.emit('dynamicChannelLeave', state, dynamicChannel);
		}
	});

	client.on('voiceChannelChange', async (
		oldState: VoiceState,
		newState: VoiceState,
	) => {
		try {
			const oldDynamicChannel = await findDynamicChannelFor(oldState);
			if (oldState.channel) {
				client.emit('voiceChannelLeave', oldState, oldDynamicChannel);
			}

			const newDynamicChannel = await findDynamicChannelFor(newState);
			if (newState.channel) {
				client.emit('voiceChannelJoin', newState, newDynamicChannel);
			}
		} catch (err) {
			logError('voiceChannelChange handler failed', err);
		}
	});

	client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
		// Compare identifiers, not object identity: discord.js hands out
		// different channel instances per event, so `===` on the objects made
		// mute/deafen updates look like channel moves.
		if (oldState.channelId === newState.channelId) return;

		logger.verbose(
			`${newState.member?.user.username ?? 'unknown'} changed from ` +
			`${oldState.channel?.name ?? 'none'} to ` +
			`${newState.channel?.name ?? 'none'}`,
		);

		client.emit('voiceChannelChange', oldState, newState);
	});
};

const shutdown = async (
	client: Client,
	sequelize: Sequelize,
	code: number,
): Promise<void> => {
	try {
		client.removeAllListeners();
		await client.destroy();
	} catch (err) {
		logError('Failed to destroy the Discord client cleanly', err);
	}
	await closeDatabase(sequelize);
	process.exit(code);
};

const main = async (): Promise<void> => {
	let config: AppConfig;
	try {
		config = loadConfig();
	} catch (err) {
		// Configuration errors are fatal and must be visible on stderr even if
		// the logger failed to initialise.
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
		return;
	}

	let sequelize: Sequelize;
	try {
		sequelize = createSequelize(config.database);
	} catch (err) {
		logError('Database driver initialisation failed — aborting startup', err);
		process.exit(1);
		return;
	}
	const client = createClient();

	process.on('unhandledRejection', (reason) => {
		logError('Unhandled promise rejection', reason);
	});
	process.on('uncaughtException', (err) => {
		logError('Uncaught exception', err);
		void shutdown(client, sequelize, 1);
	});

	try {
		// Fail fast: a bot that comes online without a schema serves errors.
		await connectDatabase(sequelize);
	} catch (err) {
		logError('Database initialisation failed — aborting startup', err);
		await closeDatabase(sequelize);
		process.exit(1);
		return;
	}

	registerHandlers(client, sequelize);

	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.on(signal, () => {
			logger.info(`Received ${signal}, shutting down...`);
			void shutdown(client, sequelize, 0);
		});
	}

	try {
		await client.login(config.discordToken);
	} catch (err) {
		logError('Discord login failed', err);
		await shutdown(client, sequelize, 1);
	}
};

void main();
