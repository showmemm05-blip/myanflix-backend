import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

/**
 * bam-16: "a payment account was created, edited or deleted", for in-process
 * listeners. BankEventsService caches each account's active flag for a
 * minute; it listens here and forgets that cache at once, so an account an
 * admin just deactivated stops being accepted by bank-event ingestion
 * immediately instead of up to a minute later.
 *
 * A plain Subject in its own file (provided and exported by
 * PaymentAccountsModule) so BankEventsModule can listen without depending
 * on PaymentAccountsService itself. Fired only after the change is saved.
 */
@Injectable()
export class PaymentAccountEvents implements OnModuleDestroy {
  private readonly subject = new Subject<void>();

  /** Emits once per saved change. */
  get changes(): Observable<void> {
    return this.subject.asObservable();
  }

  emitChanged(): void {
    this.subject.next();
  }

  onModuleDestroy(): void {
    this.subject.complete();
  }
}
