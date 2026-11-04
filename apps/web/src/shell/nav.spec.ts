import { describe, expect, it } from 'vitest';
import { visibleNavItems } from './nav';

describe('visibleNavItems (AC-25)', () => {
  const ids = (role?: 'admin' | 'staff') => visibleNavItems(role).map((item) => item.id);

  it('shows the Staff page only to an administrator', () => {
    expect(ids('admin')).toContain('staff');
    expect(ids('staff')).not.toContain('staff');
  });

  it('hides it while the role is not known yet, rather than flashing it', () => {
    expect(ids()).not.toContain('staff');
    expect(ids()).toContain('home');
  });
});
