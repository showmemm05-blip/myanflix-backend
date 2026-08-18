export interface JwtPayload {
  sub: string;
}

export interface RefreshPayload {
  sub: string;
  jti: string;
}
