// Small text formatting helpers shared by commands and UI.

export const pluralFiles = (count: number): string => `${count} file${count === 1 ? '' : 's'}`;
