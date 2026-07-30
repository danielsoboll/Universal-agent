/** Zentrale Marke — General Agent */
export const APP_NAME = "General Agent";
export const APP_TAGLINE = "Universal Knowledge Analyzer";
export const APP_ICON_VERSION = "ga-1";

const APP_ICON_FILES = {
  180: "/icons/icon-180.png",
  192: "/icons/icon-192.png",
  512: "/icons/icon-512.png",
} as const;

export const APP_ICON_PATHS = {
  180: `${APP_ICON_FILES[180]}?v=${APP_ICON_VERSION}`,
  192: `${APP_ICON_FILES[192]}?v=${APP_ICON_VERSION}`,
  512: `${APP_ICON_FILES[512]}?v=${APP_ICON_VERSION}`,
} as const;

export const BRAND_MARK_PATH = `/brand/mark.svg?v=${APP_ICON_VERSION}`;
export const APP_MANIFEST_PATH = `/manifest.webmanifest?v=${APP_ICON_VERSION}`;

export function getAppIconPath(size: 180 | 192 | 512 = 192): string {
  return APP_ICON_PATHS[size];
}
