/** One shell word, single-quoted, with embedded single quotes kept. */
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
