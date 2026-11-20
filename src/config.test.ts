import {ConfigError, loadConfig, redactSecrets} from './config';

const token = 'A'.repeat(30) + '.' + 'B'.repeat(10) + '.' + 'C'.repeat(30);

const baseEnv = (): Record<string, string> => ({
	DD_DISCORD_BOT_TOKEN: token,
	NODE_ENV: 'development',
});

describe('loadConfig', () => {
	it('fails closed when the bot token is missing', () => {
		expect(() => loadConfig({})).toThrow(ConfigError);
		expect(() => loadConfig({})).toThrow(/DD_DISCORD_BOT_TOKEN/);
	});

	it('rejects placeholder tokens', () => {
		expect(() => loadConfig({
			DD_DISCORD_BOT_TOKEN: 'ใส่โทเคนบอท',
		})).toThrow(/does not look like/);
	});

	it('uses sqlite outside production', () => {
		const config = loadConfig(baseEnv());
		expect(config.database.dialect).toBe('sqlite');
		expect(config.database.storage).toBe('./database.sqlite');
	});

	it('requires every production database variable', () => {
		const env = {...baseEnv(), NODE_ENV: 'production'};
		expect(() => loadConfig(env)).toThrow(ConfigError);
		const config = loadConfig({
			...env,
			DD_DBPROD_HOST: 'db.internal',
			DD_DBPROD_NAME: 'voices',
			DD_DBPROD_USER: 'bot',
			DD_DBPROD_PASS: 'secret',
		});
		expect(config.database).toMatchObject({
			dialect: 'mysql',
			host: 'db.internal',
			port: 3306,
			database: 'voices',
			username: 'bot',
			password: 'secret',
		});
	});

	it('rejects a malformed database port', () => {
		const env = {
			...baseEnv(),
			NODE_ENV: 'production',
			DD_DBPROD_HOST: 'db.internal',
			DD_DBPROD_NAME: 'voices',
			DD_DBPROD_USER: 'bot',
			DD_DBPROD_PASS: 'secret',
			DD_DBPROD_PORT: 'not-a-port',
		};
		expect(() => loadConfig(env)).toThrow(/1 and 65535/);
	});
});

describe('redactSecrets', () => {
	it('removes discord tokens and password query parameters from log text', () => {
		const log =
			`login failed for ${token} password=hunter2 ` +
			'Authorization: Bearer ' + token;
		const redacted = redactSecrets(log);
		expect(redacted).not.toContain(token);
		expect(redacted).not.toContain('hunter2');
		expect(redacted).toContain('[REDACTED_DISCORD_TOKEN]');
		expect(redacted).toContain('[REDACTED]');
	});
});
