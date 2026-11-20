/**
 * Centralised runtime configuration with fail-fast validation.
 *
 * Every value is read once at startup. Nothing in this module logs a secret
 * value: error messages only ever name the offending key.
 */

export type DatabaseDialect = 'mysql' | 'sqlite';

export interface DatabaseConfig {
	dialect: DatabaseDialect;
	logging: boolean;
	/** mysql only */
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string;
	/** sqlite only */
	storage?: string;
}

export interface AppConfig {
	nodeEnv: string;
	isProduction: boolean;
	discordToken: string;
	logDir: string;
	database: DatabaseConfig;
}

/** Thrown when the process environment cannot produce a usable config. */
export class ConfigError extends Error {
	readonly missingKeys: string[];

	constructor(message: string, missingKeys: string[] = []) {
		super(message);
		this.name = 'ConfigError';
		this.missingKeys = missingKeys;
	}
}

type EnvLike = Record<string, string | undefined>;

const readString = (env: EnvLike, key: string): string | undefined => {
	const raw = env[key];
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const readPort = (env: EnvLike, key: string, fallback: number): number => {
	const raw = readString(env, key);
	if (raw === undefined) return fallback;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new ConfigError(
			`Environment variable ${key} must be an integer between 1 and 65535.`,
			[key],
		);
	}
	return port;
};

/**
 * Discord bot tokens are opaque, but they are always long and never contain
 * whitespace. This rejects obvious placeholders ("ใส่โทเคนบอท", "CHANGEME")
 * before the process tries to reach the gateway.
 */
export const isPlausibleDiscordToken = (token: string): boolean =>
	/^[A-Za-z0-9._-]{30,}$/.test(token);

export const loadConfig = (env: EnvLike = process.env): AppConfig => {
	const nodeEnv = readString(env, 'NODE_ENV') ?? 'development';
	const isProduction = nodeEnv === 'production';

	const discordToken = readString(env, 'DD_DISCORD_BOT_TOKEN');
	if (discordToken === undefined) {
		throw new ConfigError(
			'DD_DISCORD_BOT_TOKEN is required but was not set.',
			['DD_DISCORD_BOT_TOKEN'],
		);
	}
	if (!isPlausibleDiscordToken(discordToken)) {
		throw new ConfigError(
			'DD_DISCORD_BOT_TOKEN is set but does not look like a valid ' +
			'Discord bot token.',
			['DD_DISCORD_BOT_TOKEN'],
		);
	}

	const logDir = readString(env, 'DD_LOG_DIR') ?? 'logs';

	if (isProduction) {
		const required = [
			'DD_DBPROD_HOST',
			'DD_DBPROD_NAME',
			'DD_DBPROD_USER',
			'DD_DBPROD_PASS',
		];
		const missing = required.filter((key) => readString(env, key) === undefined);
		if (missing.length > 0) {
			throw new ConfigError(
				`Missing required production database variable(s): ` +
				`${missing.join(', ')}.`,
				missing,
			);
		}

		return {
			nodeEnv,
			isProduction,
			discordToken,
			logDir,
			database: {
				dialect: 'mysql',
				logging: false,
				host: readString(env, 'DD_DBPROD_HOST'),
				port: readPort(env, 'DD_DBPROD_PORT', 3306),
				database: readString(env, 'DD_DBPROD_NAME'),
				username: readString(env, 'DD_DBPROD_USER'),
				password: readString(env, 'DD_DBPROD_PASS'),
			},
		};
	}

	return {
		nodeEnv,
		isProduction,
		discordToken,
		logDir,
		database: {
			dialect: 'sqlite',
			logging: false,
			storage: readString(env, 'DD_SQLITE_STORAGE') ?? './database.sqlite',
		},
	};
};

/**
 * Redacts anything that looks like a Discord token or a bearer credential so
 * log lines and error messages can never leak a secret.
 */
export const redactSecrets = (input: string): string => {
	return input
		.replace(
			/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,
			'[REDACTED_DISCORD_TOKEN]',
		)
		.replace(/\b(Bearer|Bot)\s+[A-Za-z0-9._-]{20,}/gi, '$1 [REDACTED]')
		.replace(/password=[^&\s]+/gi, 'password=[REDACTED]');
};
