export const ACQUISITION_PROVIDERS = ["twitterapi_io", "twscrape"] as const;

export type AcquisitionProvider = (typeof ACQUISITION_PROVIDERS)[number];

export interface AcquisitionProviderDefinition {
  id: AcquisitionProvider;
  label: string;
  usesPaidCredits: boolean;
}

export const ACQUISITION_PROVIDER_DEFINITIONS: readonly AcquisitionProviderDefinition[] = [
  { id: "twitterapi_io", label: "TwitterAPI.io", usesPaidCredits: true },
  { id: "twscrape", label: "twscrape", usesPaidCredits: false },
];

export function parseAcquisitionProvider(value: unknown): AcquisitionProvider | null {
  return typeof value === "string" && ACQUISITION_PROVIDERS.includes(value as AcquisitionProvider)
    ? (value as AcquisitionProvider)
    : null;
}

export function acquisitionProviderLabel(provider: AcquisitionProvider): string {
  return ACQUISITION_PROVIDER_DEFINITIONS.find((row) => row.id === provider)?.label || provider;
}
