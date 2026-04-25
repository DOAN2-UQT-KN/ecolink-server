export const OAUTH_PROVIDER = {
  GOOGLE: "GOOGLE",
} as const;

export interface GoogleOauthConfig {
  readonly provider: typeof OAUTH_PROVIDER.GOOGLE;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly userInfoEndpoint: string;
  readonly scope: string[];
}
