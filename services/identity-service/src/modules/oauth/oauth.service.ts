export interface OAuthService<TTokenResult, TCallbackResult> {
  getAuthorizationUrl(state?: string): string;
  exchangeToken(code: string): Promise<TTokenResult>;
  handleCallback(code: string, state?: string): Promise<TCallbackResult>;
}
