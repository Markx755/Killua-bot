module.exports = {
	'env': {
		'browser': true,
		'node': true,
		'es2021': true,
		'jest': true,
	},
	'extends': [
		'google',
	],
	'parser': '@typescript-eslint/parser',
	'parserOptions': {
		'ecmaVersion': 'latest',
		'sourceType': 'module',
	},
	'plugins': [
		'@typescript-eslint',
	],
	'rules': {
		// Google's JS-era JSDoc rules do not understand TypeScript signatures.
		'valid-jsdoc': 'off',
		'require-jsdoc': 'off',
		'no-unused-vars': 'off',
		'@typescript-eslint/no-unused-vars': ['warn', {'argsIgnorePattern': '^_'}],
		'comma-dangle': ['error', 'always-multiline'],
		'comma-spacing': [
			'error',
			{
				before: false, after: true,
			},
		],
		'comma-style': ['error', 'last'],
		'indent': ['error', 'tab'],
		'new-cap': [
			'error',
			{
				'capIsNew': false,
				'properties': false,
			},
		],
		'quotes': ['error', 'single', {'allowTemplateLiterals': true}],
		'max-len': [
			'error',
			{
				'code': 100,
				'ignoreStrings': true,
				'ignoreTemplateLiterals': true,
				'ignoreComments': true,
			},
		],
		'no-tabs': 0,
		'no-mixed-spaces-and-tabs': [2, 'smart-tabs'],
	},
};
