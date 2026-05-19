// Маппинг префикса idInstance → API URL Green API. У свежих instance shard
// в host'е (1103, 3100, 4100), у старых (1101948511) — общий api.green-api.com.
// При появлении нового shard'а — обновить эту мапу. Не дублировать в других
// файлах, импортировать отсюда.
export function greenApiUrl(idInstance: string): string {
	const known: Record<string, string> = {
		"1103487233": "https://1103.api.green-api.com",
		"1101948511": "https://api.green-api.com",
		"3100621187": "https://3100.api.green-api.com",
		"4100621194": "https://4100.api.green-api.com",
	};
	return known[idInstance] || "https://api.green-api.com";
}
