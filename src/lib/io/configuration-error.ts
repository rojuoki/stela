/** A safe configuration failure that an IO route may explain to a local developer. */
export class IoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IoConfigurationError";
  }
}

export function ioConfigurationMessage(): string {
  return process.env.NODE_ENV === "production"
    ? "The IO service is temporarily unavailable"
    : "Couldn’t connect to the IO development database. Set STELA_IO_DATABASE_URL and STELA_IO_AUTH_SECRET in .env.local, then restart the development server.";
}
