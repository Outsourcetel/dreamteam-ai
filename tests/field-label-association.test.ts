// ============================================================================
// The Field primitive must NAME its control.
//
// WHY THIS FILE EXISTS. `src/design/primitives.tsx`'s Field rendered a bare
// <label> as a SIBLING of its control, with no htmlFor and no id — so the label
// named nothing. Field is used 81 times across 18 files, which made this one
// primitive the largest single contributor to an estate-wide count of 536 of 581
// form controls with no accessible name. A screen reader reached all of them as
// "edit, blank", and WCAG 2.1 AA 4.1.2 is a procurement gate for the enterprise
// buyers this is sold to.
//
// WHY IT RENDERS RATHER THAN GREPS. A source-text assertion ("the file contains
// htmlFor") would pass against a Field that computes an id and never puts it on
// the control — which is most of the ways this can be got wrong. So these drive
// the real component through react-dom/server and assert on the emitted markup.
// There is no jsdom in this repo and vitest's include pattern is `*.test.ts`,
// so the elements are built with React.createElement rather than JSX; that is a
// spelling difference, not a weaker test.
//
// PROVEN ABLE TO FAIL: reverting Field to the sibling-label form turns tests
// 1, 2, 4 and 5 red (measured 2026-08-22).
// ============================================================================
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Field, INPUT_CLS } from '../src/design/primitives';

const h = React.createElement;
const render = (el: React.ReactElement) => renderToStaticMarkup(el);

/** Pull the value of an attribute off the first tag that carries it. */
const attr = (html: string, tag: string, name: string): string | null => {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(html);
  return m ? m[1] : null;
};

describe('Field associates its label with its control', () => {
  it('1. gives an unadorned input an id and points the label at it', () => {
    const html = render(h(Field, { label: 'Workspace name' }, h('input', { className: INPUT_CLS })));
    const forAttr = attr(html, 'label', 'for');
    const inputId = attr(html, 'input', 'id');
    expect(forAttr, 'label has no for attribute').toBeTruthy();
    expect(inputId, 'input has no id').toBeTruthy();
    expect(forAttr).toBe(inputId);
  });

  it('2. gives every Field on a page a DISTINCT id', () => {
    // Two Fields rendered in one tree must not collide, or the second label
    // silently points at the first control — worse than no association.
    const html = render(h('form', null,
      h(Field, { label: 'First', key: 'a' }, h('input', {})),
      h(Field, { label: 'Second', key: 'b' }, h('input', {})),
    ));
    const ids = [...html.matchAll(/<input\b[^>]*\bid="([^"]*)"/g)].map((m) => m[1]);
    const fors = [...html.matchAll(/<label\b[^>]*\bfor="([^"]*)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size, 'the two inputs share an id').toBe(2);
    expect(fors).toEqual(ids);
  });

  it('3. never overrides an id the caller set', () => {
    const html = render(h(Field, { label: 'Slug' }, h('input', { id: 'tenant-slug' })));
    expect(attr(html, 'input', 'id')).toBe('tenant-slug');
    expect(attr(html, 'label', 'for')).toBe('tenant-slug');
  });

  it('4. wires hint and error text through aria-describedby', () => {
    const html = render(h(Field,
      { label: 'Spend cap', hint: 'Per calendar month.', error: 'Must be a number.' },
      h('input', {})));
    const described = attr(html, 'input', 'aria-describedby');
    expect(described, 'no aria-describedby').toBeTruthy();
    const ids = described!.split(/\s+/);
    expect(ids).toHaveLength(2);
    // Both referenced ids must actually exist in the markup, or the attribute
    // is a dangling pointer that reads as nothing.
    for (const id of ids) expect(html, `aria-describedby names missing id ${id}`).toContain(`id="${id}"`);
    expect(html).toContain('Per calendar month.');
    expect(html).toContain('Must be a number.');
  });

  it('5. marks the control invalid and announces the error', () => {
    const html = render(h(Field, { label: 'Email', error: 'Not a valid address.' }, h('input', {})));
    expect(attr(html, 'input', 'aria-invalid')).toBe('true');
    expect(html, 'the error is drawn but never announced').toContain('role="alert"');
  });

  it('6. leaves a non-control child structurally untouched', () => {
    // A layout <div> must NOT collect the id: `<label for>` pointing at a
    // non-control is invalid, focuses nothing, and passes a naive audit.
    const html = render(h(Field, { label: 'Colour' }, h('div', { className: 'swatches' }, 'pick one')));
    expect(attr(html, 'div', 'id'), 'the id landed on a layout div').toBeNull();
    expect(attr(html, 'label', 'for'), 'label points at a non-control').toBeNull();
    expect(html).toContain('pick one');
  });

  it('7. still renders a clean field when there is nothing to report', () => {
    const html = render(h(Field, { label: 'Notes' }, h('textarea', {})));
    expect(attr(html, 'textarea', 'id')).toBe(attr(html, 'label', 'for'));
    expect(attr(html, 'textarea', 'aria-describedby'), 'dangling describedby with no hint or error').toBeNull();
    expect(html).not.toContain('role="alert"');
  });
});
