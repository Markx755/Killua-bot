import {mkdirSync} from 'node:fs';
import winston from 'winston';

import {redactSecrets} from './config';

const logDir = process.env.DD_LOG_DIR ?? 'logs';

// Winston throws on the first write if the directory does not exist, which
// used to crash the bot before any error could be reported.
try {
	mkdirSync(logDir, {recursive: true});
} catch (err) {
	console.error(`Unable to create log directory "${logDir}":`, err);
}

const redactFormat = winston.format((info) => {
	if (typeof info.message === 'string') {
		info.message = redactSecrets(info.message);
	}
	return info;
});

export const logger = winston.createLogger({
	level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
	format: winston.format.combine(
		redactFormat(),
		winston.format.timestamp(),
		winston.format.json(),
	),
	transports: [
		new winston.transports.File({
			filename: `${logDir}/error.log`,
			level: 'error',
		}),
		new winston.transports.File({
			filename: `${logDir}/combined.log`,
			level: 'verbose',
		}),
	],
});

logger.add(
	new winston.transports.Console({
		format: winston.format.cli(),
		level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
	}),
);

/**
 * Logs an unknown thrown value without ever dumping a raw secret. Prefer this
 * over `logger.error(err)` + `logger.error(err.stack)` so that tokens embedded
 * in Discord API errors stay out of `logs/`.
 */
export const logError = (context: string, err: unknown): void => {
	const message = err instanceof Error ? err.message : String(err);
	logger.error(`${context}: ${redactSecrets(message)}`);
	if (err instanceof Error && err.stack !== undefined) {
		logger.debug(redactSecrets(err.stack));
	}
};
