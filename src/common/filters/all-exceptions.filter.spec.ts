import {
  ArgumentsHost,
  BadRequestException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { RoutesResolver } from '@nestjs/core/router/routes-resolver';
import createHttpError from 'http-errors';
import { CodedHttpException } from '../errors/coded-http.exception';
import {
  AllExceptionsFilter,
  BODY_PARSER_ERROR_TYPES,
} from './all-exceptions.filter';

function hostFor(response: { status: jest.Mock; json: jest.Mock }) {
  return {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

function run(exception: unknown) {
  const response = { status: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  new AllExceptionsFilter().catch(exception, hostFor(response));
  return {
    status: response.status.mock.calls[0]?.[0] as number,
    body: response.json.mock.calls[0]?.[0] as Record<string, unknown>,
  };
}

describe('AllExceptionsFilter', () => {
  it('keeps the plain { success:false, message } envelope for ordinary HttpExceptions', () => {
    expect(run(new BadRequestException('Nope'))).toEqual({
      status: 400,
      body: { success: false, message: 'Nope' },
    });
    // A validation failure's message list is still joined, nothing else leaks.
    expect(run(new BadRequestException(['a is bad', 'b is bad'])).body).toEqual(
      {
        success: false,
        message: 'a is bad, b is bad',
      },
    );
  });

  it("adds a CodedHttpException's code and extra fields", () => {
    const error = new CodedHttpException(
      HttpStatus.LOCKED,
      'SOME_CODE',
      'Locked for now.',
      { lockedUntil: '2026-10-05T08:15:00.000Z', triesLeft: 0 },
    );
    expect(run(error)).toEqual({
      status: 423,
      body: {
        success: false,
        message: 'Locked for now.',
        code: 'SOME_CODE',
        lockedUntil: '2026-10-05T08:15:00.000Z',
        triesLeft: 0,
      },
    });
  });

  it('extra fields can never override success, message or code', () => {
    const error = new CodedHttpException(400, 'REAL_CODE', 'Real message.', {
      success: true,
      message: 'fake',
      code: 'FAKE',
    });
    expect(run(error).body).toEqual({
      success: false,
      message: 'Real message.',
      code: 'REAL_CODE',
    });
  });

  it('an unexpected error is still a bare 500', () => {
    const logger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    expect(run(new Error('boom'))).toEqual({
      status: 500,
      body: { success: false, message: 'Internal server error' },
    });
    logger.mockRestore();
  });

  describe('Express body-parser errors (M-18)', () => {
    let logger: jest.SpyInstance;
    beforeEach(() => {
      logger = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
    });
    afterEach(() => logger.mockRestore());

    it('an over-limit body is a clean 413, not a logged 500', () => {
      // Exactly what raw-body throws for a body over the route's limit.
      const error = createHttpError(413, 'request entity too large', {
        type: 'entity.too.large',
        length: 30_000_000,
        limit: 1_048_576,
      });
      expect(run(error)).toEqual({
        status: 413,
        body: { success: false, message: 'Request body too large' },
      });
      expect(logger).not.toHaveBeenCalled();
    });

    it('malformed JSON is the same 400 with the parser wording whether Nest mapped it first or not', () => {
      // What body-parser really throws: the SyntaxError itself, tagged.
      const parserError = createHttpError(
        400,
        new SyntaxError('Unexpected token } in JSON at position 12'),
        { type: 'entity.parse.failed' },
      );
      expect(parserError).toBeInstanceOf(SyntaxError);

      // In the real pipeline Nest's error layer maps any SyntaxError to a
      // BadRequestException(message) before this filter sees it. Prove that
      // with Nest's own mapper, then prove both roads give the same answer.
      const mapped = (
        RoutesResolver.prototype as unknown as {
          mapExternalException: (err: unknown) => unknown;
        }
      ).mapExternalException(parserError);
      expect(mapped).toBeInstanceOf(BadRequestException);

      const expected = {
        status: 400,
        body: {
          success: false,
          message: 'Unexpected token } in JSON at position 12',
        },
      };
      expect(run(mapped)).toEqual(expected);
      expect(run(parserError)).toEqual(expected);
      expect(logger).not.toHaveBeenCalled();
    });

    it('other parser 4xx errors keep their own status and message', () => {
      const error = createHttpError(415, 'unsupported charset "UTF-7"', {
        type: 'charset.unsupported',
      });
      expect(run(error)).toEqual({
        status: 415,
        body: { success: false, message: 'unsupported charset "UTF-7"' },
      });
    });

    it('a 5xx http-error is still the bare, logged 500', () => {
      expect(run(createHttpError(502, 'bad gateway'))).toEqual({
        status: 500,
        body: { success: false, message: 'Internal server error' },
      });
      expect(logger).toHaveBeenCalledTimes(1);
    });

    it('a random error that merely has a statusCode-looking field outside 4xx is a 500', () => {
      const error = Object.assign(new Error('nope'), { statusCode: 200 });
      expect(run(error).status).toBe(500);
    });

    it('a 4xx error from anything other than body-parser is still a bare, logged 500', () => {
      // No `type` tag at all (a future dependency's error, say)...
      const untyped = createHttpError(422, 'secret detail from some library');
      expect(run(untyped)).toEqual({
        status: 500,
        body: { success: false, message: 'Internal server error' },
      });
      // ...or a tag body-parser never produces.
      const foreign = Object.assign(new Error('secret detail'), {
        statusCode: 400,
        type: 'some.other.library',
      });
      expect(run(foreign)).toEqual({
        status: 500,
        body: { success: false, message: 'Internal server error' },
      });
      expect(logger).toHaveBeenCalledTimes(2);
    });

    it('every body-parser error type is recognised', () => {
      for (const type of BODY_PARSER_ERROR_TYPES) {
        const { status } = run(createHttpError(400, 'x', { type }));
        expect(status).toBe(400);
      }
      expect(logger).not.toHaveBeenCalled();
    });
  });
});
