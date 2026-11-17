/** Which kind of device a route group is for. v3 serves the phone (device_type 'phone' or 'tablet') and the watch ('watch'): services/auth/deviceKind.ts. */
export type Kind = 'phone' | 'watch';

/** Who a request is for, found from its access token. */
export interface AuthInfo {
  userid: string;
  downloadid: string;
  deviceType: string | null;
}

/** What login and refresh give back. The access token is a JWT; the refresh token is a random value. */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginInput {
  deviceid: string;
  userid: string;
  downloadid: string;
  applegoogleid: string;
  device: string;
}
