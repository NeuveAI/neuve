/** Worker progress must represent new charged work and cross the port at most once a second. */
export const relayChargedProgress = (
  send: (units: number) => void,
  now = () => performance.now(),
) => {
  let sentAt = -Infinity;
  let sentUnits = 0;
  return (units: number) => {
    const time = now();
    if (
      !Number.isSafeInteger(units) ||
      units <= sentUnits ||
      time - sentAt < 1000
    )
      return;
    sentUnits = units;
    sentAt = time;
    send(units);
  };
};

export const validProgress = (
  previous: number,
  units: number,
  maximum: number,
) =>
  Number.isSafeInteger(units) &&
  units > Math.max(0, previous) &&
  units <= maximum;
