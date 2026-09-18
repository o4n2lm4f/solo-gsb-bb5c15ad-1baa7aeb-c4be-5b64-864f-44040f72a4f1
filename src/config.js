/**
 * Runtime configuration, overridable via environment variables.
 */
export const config = {
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  host: process.env.HOST ?? '0.0.0.0',
  /** Hard cap on the number of satisfiable (pre-coalesce) ranges per request. */
  maxRanges: Number.parseInt(process.env.MAX_RANGES ?? '16', 10),
  /** Multiplier of the resource size that the planned transfer must not exceed. */
  maxBytesMultiplier: Number.parseInt(process.env.MAX_BYTES_MULTIPLIER ?? '2', 10),
};

export default config;
