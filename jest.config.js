module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	testMatch: ['<rootDir>/src/**/*.test.ts'],
	transform: {
		'^.+\\.tsx?$': ['ts-jest', {
			tsconfig: {
				module: 'commonjs',
				target: 'ES2022',
				esModuleInterop: true,
			},
		}],
	},
};
