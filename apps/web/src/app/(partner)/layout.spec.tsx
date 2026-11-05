import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Layout from './layout';

describe('(partner) layout', () => {
  it('renders exactly one main landmark with the skip link target, and no staff shell', () => {
    const { container } = render(<Layout params={Promise.resolve({})}>content</Layout>);

    expect(container.querySelectorAll('main#main-content')).toHaveLength(1);
    expect(container.querySelector('nav, header')).toBeNull();
  });
});
