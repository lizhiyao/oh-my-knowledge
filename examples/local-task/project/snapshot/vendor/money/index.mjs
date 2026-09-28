export const money = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
