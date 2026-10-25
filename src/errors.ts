/**
 * Central error types for Threshold Guardian.
 *
 * Every failure mode gets a distinct class so the CLI can explain to a
 * beginner what went wrong and what to do about it.
 */

/** Raised when the configuration file is missing, unreadable, or invalid. */
export class ConfigError extends Error {
  public override readonly name = "ConfigError";

  constructor(message: string) {
    super(message);
  }
}

/** Raised when chain data is unavailable, invalid, or the network rejects us. */
export class ChainDataError extends Error {
  public override readonly name = "ChainDataError";

  constructor(message: string) {
    super(message);
  }
}

/** Raised when the chain does not match the configured network. */
export class NetworkMismatchError extends Error {
  public override readonly name = "NetworkMismatchError";

  constructor(message: string) {
    super(message);
  }
}
