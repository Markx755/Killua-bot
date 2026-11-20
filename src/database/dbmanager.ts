import {Sequelize} from 'sequelize-typescript';

import {DatabaseConfig, redactSecrets} from '../config';
import {logger} from '../logger';
import DynamicVoiceChannel from './models/dynamic_voice_channel.model';
import ServerSetting from './models/server_setting.model';

const models = [DynamicVoiceChannel, ServerSetting];

/** Thrown when the database cannot be reached or synchronised. */
export class DatabaseInitError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message);
		this.name = 'DatabaseInitError';
	}
}

/**
 * Builds the Sequelize instance.
 *
 * The previous implementation nested `user`, `password` and `database` inside
 * `dialectOptions`, where Sequelize never looks for them, which made every
 * production start fail on authentication. They are top-level options here.
 */
export const createSequelize = (config: DatabaseConfig): Sequelize => {
	if (config.dialect === 'mysql') {
		return new Sequelize({
			dialect: 'mysql',
			host: config.host,
			port: config.port ?? 3306,
			database: config.database,
			username: config.username,
			password: config.password,
			logging: config.logging ? (msg: string) => logger.silly(msg) : false,
			models,
		});
	}

	return new Sequelize({
		dialect: 'sqlite',
		storage: config.storage ?? './database.sqlite',
		logging: config.logging ? (msg: string) => logger.silly(msg) : false,
		models,
	});
};

const describeError = (err: unknown): string => {
	if (err instanceof Error) {
		// Message only — stack traces are noisy and may contain credentials
		// embedded in a connection string.
		return redactSecrets(err.message);
	}
	return redactSecrets(String(err));
};

/**
 * Connects and synchronises the schema. Rejects on any failure so the caller
 * can abort startup instead of running a bot against a dead database.
 */
export const connectDatabase = async (
	sequelize: Sequelize,
): Promise<void> => {
	logger.info('Connecting to the database...');
	try {
		await sequelize.authenticate();
		logger.info('Database connection established.');
	} catch (err) {
		throw new DatabaseInitError(
			`Database authentication failed: ${describeError(err)}`,
			err,
		);
	}

	logger.info('Synchronising database models...');
	try {
		// `sync()` is awaited: the previous code logged "successful" while the
		// promise was still pending, so slash command handlers could query
		// tables that did not exist yet.
		await sequelize.sync();
		logger.info('Database schema synchronised.');
	} catch (err) {
		throw new DatabaseInitError(
			`Database synchronisation failed: ${describeError(err)}`,
			err,
		);
	}
};

export const closeDatabase = async (sequelize: Sequelize): Promise<void> => {
	try {
		await sequelize.close();
		logger.info('Database connection closed.');
	} catch (err) {
		logger.warn(`Failed to close the database cleanly: ${describeError(err)}`);
	}
};
