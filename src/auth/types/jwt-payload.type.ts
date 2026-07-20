export interface JwtPayload {
  sub: string;
  email: string;
}

export interface RefreshPayload {
  sub: string;
  jti: string;
}
