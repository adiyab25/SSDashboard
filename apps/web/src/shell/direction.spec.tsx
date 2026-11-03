import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Direction } from 'radix-ui';
import { afterEach, describe, expect, it } from 'vitest';
import { DirectionBridge, useDirectionSetting } from './direction';

function Probe() {
  const { dir, setDir } = useDirectionSetting();
  const radix = Direction.useDirection();
  return (
    <>
      <output aria-label="setting">{dir}</output>
      <output aria-label="radix">{radix}</output>
      <button onClick={() => setDir(dir === 'ltr' ? 'rtl' : 'ltr')}>flip</button>
    </>
  );
}

const renderBridge = () =>
  render(
    <DirectionBridge>
      <Probe />
    </DirectionBridge>,
  );

describe('DirectionBridge', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.dir = '';
  });

  it('starts left to right', () => {
    renderBridge();

    expect(screen.getByLabelText('setting')).toHaveTextContent('ltr');
    expect(screen.getByLabelText('radix')).toHaveTextContent('ltr');
  });

  it('reads the stored direction', () => {
    localStorage.setItem('ss_dir', 'rtl');

    renderBridge();

    expect(screen.getByLabelText('radix')).toHaveTextContent('rtl');
  });

  it('switches html dir, Radix, and storage together without a reload', async () => {
    renderBridge();

    await userEvent.click(screen.getByRole('button', { name: 'flip' }));

    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByLabelText('radix')).toHaveTextContent('rtl');
    expect(localStorage.getItem('ss_dir')).toBe('rtl');
  });
});
