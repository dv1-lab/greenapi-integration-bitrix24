/** @type {import('jest').Config} */
module.exports = {
	preset: "ts-jest",
	testEnvironment: "node",
	rootDir: "./",
	roots: ["<rootDir>/src"],
	testRegex: ".*\\.(spec|test)\\.ts$",
	transform: { "^.+\\.ts$": ["ts-jest", {}] },
	moduleFileExtensions: ["ts", "js", "json"],
	moduleNameMapper: {
		"^@/(.*)$": "<rootDir>/src/$1",
	},
	// Покрытие — не блокирующее на этом этапе, чтобы не тормозить смок-тесты.
	collectCoverageFrom: [
		"src/**/*.ts",
		"!src/**/*.dto.ts",
		"!src/**/dto.ts",
		"!src/main.ts",
		"!src/**/*.module.ts",
	],
	// Кэш для скорости (NestJS большой).
	cacheDirectory: "<rootDir>/.jest-cache",
	// Скрываем warning'и от ts-jest про legacy strict NestJS-кода.
	testPathIgnorePatterns: ["/node_modules/", "/dist/"],
};
