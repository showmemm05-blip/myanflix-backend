/**
 * Meta-spec (security audit 2026-10-06, finding I-20).
 *
 * PermissionsGuard is NOT a global APP_GUARD: `@RequirePermissions(...)` only
 * does something when the controller class or the handler also carries
 * `@UseGuards(PermissionsGuard)`. A forgotten `@UseGuards` would silently open
 * a staff route to every signed-in user. This spec walks every controller in
 * src/, reads the Nest metadata the decorators wrote, and fails naming the
 * controller + method whenever a permission requirement has no guard to
 * enforce it. Zero runtime change.
 */
import { CanActivate, Controller, Get, UseGuards } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import * as fs from 'fs';
import * as path from 'path';
import {
  PERMISSIONS_KEY,
  RequirePermissions,
} from '../decorators/permissions.decorator';
import { PermissionsGuard } from './permissions.guard';

const SRC_ROOT = path.resolve(__dirname, '..', '..');

function isSpecFile(name: string): boolean {
  return name.endsWith('.spec.ts') || name.endsWith('.d.ts');
}

/**
 * A file is a controller file when it follows the `*.controller.ts` naming
 * convention OR its source mentions `@Controller(` anywhere. The second rule
 * means a controller that lands in an oddly named file (say
 * `refunds.routes.ts`) is still checked instead of silently skipped.
 */
function isControllerSource(name: string, source: string): boolean {
  if (isSpecFile(name)) return false;
  if (!name.endsWith('.ts')) return false;
  return name.endsWith('.controller.ts') || source.includes('@Controller(');
}

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      listTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

function listControllerFiles(dir: string): string[] {
  return listTsFiles(dir).filter((file) =>
    isControllerSource(path.basename(file), fs.readFileSync(file, 'utf8')),
  );
}

type Ctor = abstract new (...args: never[]) => unknown;

function isClass(value: unknown): value is Ctor {
  return typeof value === 'function' && /^class\s/.test(value.toString());
}

function hasPermissionsGuard(target: object): boolean {
  const guards = Reflect.getMetadata(GUARDS_METADATA, target) as
    unknown[] | undefined;
  return Array.isArray(guards) && guards.includes(PermissionsGuard);
}

function requiresPermissions(target: object): boolean {
  return Reflect.hasMetadata(PERMISSIONS_KEY, target);
}

/**
 * Every method Nest would route for this class: its own prototype methods
 * plus the ones it inherits from a base class, the same walk Nest's
 * MetadataScanner.getAllMethodNames does. A child override shadows the base
 * method, so each name is listed once.
 */
function prototypeMethods(ctor: Ctor): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  let proto: object | null = ctor.prototype as object;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (typeof descriptor?.value === 'function') names.push(name);
    }
    proto = Reflect.getPrototypeOf(proto);
  }
  return names;
}

interface Violation {
  controller: string;
  method: string;
  file: string;
}

function violationsIn(ctor: Ctor, file: string): Violation[] {
  const violations: Violation[] = [];
  const classGuarded = hasPermissionsGuard(ctor);

  if (requiresPermissions(ctor) && !classGuarded) {
    violations.push({ controller: ctor.name, method: '<class>', file });
  }

  for (const method of prototypeMethods(ctor)) {
    const handler = ctor.prototype[method] as object;
    if (!requiresPermissions(handler)) continue;
    if (classGuarded || hasPermissionsGuard(handler)) continue;
    violations.push({ controller: ctor.name, method, file });
  }

  return violations;
}

interface Coverage {
  violations: Violation[];
  /** exported classes inspected */
  checked: number;
  /** classes that carry @RequirePermissions on the class or any method */
  permissionedClasses: number;
  /** methods that carry @RequirePermissions */
  permissionedMethods: number;
}

function collectViolations(root: string = SRC_ROOT): Coverage {
  const result: Coverage = {
    violations: [],
    checked: 0,
    permissionedClasses: 0,
    permissionedMethods: 0,
  };

  for (const file of listControllerFiles(root)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    const relFile = path.relative(root, file);

    for (const exported of Object.values(mod)) {
      if (!isClass(exported)) continue;
      result.checked += 1;
      result.violations.push(...violationsIn(exported, relFile));

      const methods = prototypeMethods(exported).filter((m) =>
        requiresPermissions(exported.prototype[m] as object),
      );
      result.permissionedMethods += methods.length;
      if (methods.length > 0 || requiresPermissions(exported)) {
        result.permissionedClasses += 1;
      }
    }
  }

  return result;
}

function formatReport(violations: Violation[]): string {
  // A string report so the failure names the offending controller + method.
  return violations
    .map(
      (v) =>
        `${v.controller}.${v.method} (${v.file}) has @RequirePermissions ` +
        'but no @UseGuards(PermissionsGuard) on the method or its class',
    )
    .join('\n');
}

/**
 * Tripwires: the real tree had 39 controller files / 39 exported classes /
 * 27 permissioned classes / 128 permissioned methods on 2026-10-06. The
 * floors sit a little under those figures so a legitimate small clean-up
 * does not trip them, but a walker bug that silently sees far fewer classes
 * (the "green because it checked nothing" failure mode) does. Lower a floor
 * only when a controller was deliberately removed.
 */
const MIN_CONTROLLER_FILES = 35;
const MIN_CLASSES_CHECKED = 35;
const MIN_PERMISSIONED_CLASSES = 24;
const MIN_PERMISSIONED_METHODS = 110;

describe('PermissionsGuard coverage (meta-spec)', () => {
  it('finds the controllers it is supposed to check', () => {
    const files = listControllerFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThanOrEqual(MIN_CONTROLLER_FILES);
    expect(
      files.some((f) => f.endsWith('multipart-upload.controller.ts')),
    ).toBe(true);
  });

  it('checks every non-spec source file that declares a @Controller, whatever its name', () => {
    // Independent of the file filter: grep the whole tree and demand that
    // each hit is in the checked list, so a controller in e.g.
    // `refunds.routes.ts` cannot be skipped by the naming convention.
    const declaring = listTsFiles(SRC_ROOT).filter(
      (file) =>
        !isSpecFile(path.basename(file)) &&
        fs.readFileSync(file, 'utf8').includes('@Controller('),
    );
    const checked = new Set(listControllerFiles(SRC_ROOT));
    const missed = declaring.filter((file) => !checked.has(file));
    expect(declaring.length).toBeGreaterThanOrEqual(MIN_CONTROLLER_FILES);
    expect(missed.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
  });

  it('every @RequirePermissions is enforced by @UseGuards(PermissionsGuard) on the method or its class', () => {
    const coverage = collectViolations();
    expect(coverage.checked).toBeGreaterThanOrEqual(MIN_CLASSES_CHECKED);
    expect(coverage.permissionedClasses).toBeGreaterThanOrEqual(
      MIN_PERMISSIONED_CLASSES,
    );
    expect(coverage.permissionedMethods).toBeGreaterThanOrEqual(
      MIN_PERMISSIONED_METHODS,
    );
    expect(formatReport(coverage.violations)).toBe('');
  });

  describe('file selection', () => {
    it('accepts the *.controller.ts convention and any file that declares @Controller(', () => {
      expect(isControllerSource('users.controller.ts', '')).toBe(true);
      expect(
        isControllerSource(
          'refunds.routes.ts',
          "@Controller('refunds')\nexport class RefundsController {}",
        ),
      ).toBe(true);
    });

    it('skips spec, declaration and non-controller files', () => {
      expect(
        isControllerSource('auth.throttling.spec.ts', "@Controller('x')"),
      ).toBe(false);
      expect(isControllerSource('x.controller.spec.ts', '')).toBe(false);
      expect(isControllerSource('types.d.ts', "@Controller('x')")).toBe(false);
      expect(isControllerSource('users.service.ts', 'class UsersService')).toBe(
        false,
      );
      expect(isControllerSource('notes.md', "@Controller('x')")).toBe(false);
    });
  });

  describe('the checker itself (so a regression cannot hide behind a silent pass)', () => {
    class OtherGuard implements CanActivate {
      canActivate(): boolean {
        return true;
      }
    }

    it('flags a class-level @RequirePermissions without the guard', () => {
      @Controller('meta-unguarded-class')
      @RequirePermissions('USERS.VIEW')
      class UnguardedClass {
        @Get()
        list(): string {
          return 'open';
        }
      }

      expect(violationsIn(UnguardedClass, 'x.controller.ts')).toEqual([
        {
          controller: 'UnguardedClass',
          method: '<class>',
          file: 'x.controller.ts',
        },
      ]);
    });

    it('flags a method-level @RequirePermissions without the guard, naming the method', () => {
      @Controller('meta-unguarded-method')
      class UnguardedMethod {
        @Get('open')
        open(): string {
          return 'open';
        }

        @Get('staff')
        @RequirePermissions('USERS.EDIT')
        staffOnly(): string {
          return 'should be staff only';
        }
      }

      const report = formatReport(
        violationsIn(UnguardedMethod, 'y.controller.ts'),
      );
      expect(report).toContain('UnguardedMethod.staffOnly (y.controller.ts)');
      expect(report).not.toContain('UnguardedMethod.open');
    });

    it('does not accept a different guard in place of PermissionsGuard', () => {
      @Controller('meta-wrong-guard')
      @UseGuards(OtherGuard)
      @RequirePermissions('USERS.VIEW')
      class WrongGuard {
        @Get()
        list(): string {
          return 'open';
        }
      }

      expect(violationsIn(WrongGuard, 'z.controller.ts')).toHaveLength(1);
    });

    it('also counts the bare @RequirePermissions() ("auth only") form as needing the guard', () => {
      @Controller('meta-bare')
      class Bare {
        @Get()
        @RequirePermissions()
        me(): string {
          return 'me';
        }
      }

      expect(violationsIn(Bare, 'b.controller.ts')).toHaveLength(1);
    });

    it('passes a class-level @UseGuards(PermissionsGuard)', () => {
      @Controller('meta-class-guarded')
      @UseGuards(PermissionsGuard)
      @RequirePermissions('USERS.VIEW')
      class ClassGuarded {
        @Get()
        @RequirePermissions('USERS.EDIT')
        edit(): string {
          return 'ok';
        }
      }

      expect(violationsIn(ClassGuarded, 'c.controller.ts')).toEqual([]);
    });

    it('passes a method-level @UseGuards(PermissionsGuard)', () => {
      @Controller('meta-method-guarded')
      class MethodGuarded {
        @Get()
        @UseGuards(PermissionsGuard)
        @RequirePermissions('USERS.VIEW')
        list(): string {
          return 'ok';
        }
      }

      expect(violationsIn(MethodGuarded, 'm.controller.ts')).toEqual([]);
    });

    it('ignores a controller with no permission requirements at all', () => {
      @Controller('meta-public')
      class PublicOnly {
        @Get()
        list(): string {
          return 'public';
        }
      }

      expect(violationsIn(PublicOnly, 'p.controller.ts')).toEqual([]);
    });

    describe('handlers inherited from a base class (Nest routes those too)', () => {
      class BaseStaff {
        @Get('danger')
        @RequirePermissions('USERS.EDIT')
        danger(): string {
          return 'inherited, should be staff only';
        }
      }

      it('lists inherited methods like Nest does, each name once', () => {
        class Child extends BaseStaff {
          @Get('own')
          own(): string {
            return 'own';
          }

          danger(): string {
            return 'override';
          }
        }

        expect(prototypeMethods(Child).sort()).toEqual(['danger', 'own']);
      });

      it('flags an unguarded inherited @RequirePermissions on the routed child', () => {
        @Controller('meta-inherit-unguarded')
        class ChildController extends BaseStaff {}

        const report = formatReport(
          violationsIn(ChildController, 'i.controller.ts'),
        );
        expect(report).toContain('ChildController.danger (i.controller.ts)');
      });

      it('passes when the child class carries @UseGuards(PermissionsGuard)', () => {
        @Controller('meta-inherit-guarded')
        @UseGuards(PermissionsGuard)
        class GuardedChild extends BaseStaff {}

        expect(violationsIn(GuardedChild, 'g.controller.ts')).toEqual([]);
      });

      it('passes when the child overrides the handler with a guarded one', () => {
        @Controller('meta-inherit-override')
        class OverridingChild extends BaseStaff {
          @Get('danger')
          @UseGuards(PermissionsGuard)
          @RequirePermissions('USERS.EDIT')
          danger(): string {
            return 'guarded override';
          }
        }

        expect(violationsIn(OverridingChild, 'o.controller.ts')).toEqual([]);
      });
    });
  });
});
