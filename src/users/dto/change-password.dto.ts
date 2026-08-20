import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/** Body of PATCH /users/me/password — the caller changing their OWN password. */
export class ChangePasswordDto {
  /**
   * Not length-checked beyond "present": an account created before today's
   * minimum could hold a shorter password, and the only thing that matters
   * here is whether it matches the stored hash.
   */
  @IsString()
  @IsNotEmpty({ message: 'Enter your current password' })
  currentPassword!: string;

  /** Same floor as registration and the phone signup flow. */
  @IsString()
  @MinLength(8, {
    message: 'New password must be at least 8 characters',
  })
  newPassword!: string;
}
