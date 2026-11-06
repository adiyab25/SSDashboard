import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  databaseUrl,
  errorReason,
  hidePassword,
  nodeMajorWarning,
  nodeVersionArg,
  nodeVersionProblems,
} from './check-timezone.mjs';

describe('nodeVersionArg', () => {
  it('reads the default of the ARG line', () => {
    assert.equal(nodeVersionArg('# x\nARG NODE_VERSION=26\nFROM node:${NODE_VERSION}'), '26');
  });

  it('is undefined without the ARG line', () => {
    assert.equal(nodeVersionArg('FROM node:26-alpine'), undefined);
  });
});

describe('nodeVersionProblems', () => {
  it('accepts equal versions', () => {
    assert.deepEqual(nodeVersionProblems('26', '26'), []);
  });

  it('flags different versions', () => {
    assert.equal(nodeVersionProblems('26', '24').length, 1);
  });

  it('flags a missing default', () => {
    assert.equal(nodeVersionProblems(undefined, '26').length, 1);
    assert.equal(nodeVersionProblems('26', undefined).length, 1);
  });
});

describe('databaseUrl', () => {
  it('prefers the owner URL, then the app URL', () => {
    assert.equal(databaseUrl({ MIGRATION_DATABASE_URL: 'a', DATABASE_URL: 'b' }), 'a');
    assert.equal(databaseUrl({ DATABASE_URL: 'b' }), 'b');
    assert.equal(databaseUrl({}), undefined);
  });
});

describe('hidePassword', () => {
  it('hides the password and keeps the rest', () => {
    const shown = hidePassword('postgres://owner:secret@localhost:5433/db');
    assert.ok(!shown.includes('secret'));
    assert.ok(shown.includes('localhost:5433/db'));
  });
});

describe('errorReason', () => {
  it('uses the message when there is one', () => {
    assert.equal(errorReason(new Error('boom')), 'boom');
  });

  it('uses the code of an error with an empty message', () => {
    const error = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    assert.equal(errorReason(error), 'ECONNREFUSED');
  });

  it('uses the inner errors of an AggregateError with no message', () => {
    const inner = [
      new Error('connect ECONNREFUSED ::1:1'),
      new Error('connect ECONNREFUSED 127.0.0.1:1'),
    ];
    const reason = errorReason(new AggregateError(inner));
    assert.ok(reason.includes('::1:1') && reason.includes('127.0.0.1:1'));
  });
});

describe('nodeMajorWarning', () => {
  it('is silent when the major versions match', () => {
    assert.equal(nodeMajorWarning('v26.1.0', '26'), undefined);
  });

  it('warns when the majors differ and names the image version', () => {
    const warning = nodeMajorWarning('v22.23.2', '26');
    assert.ok(warning.startsWith('WARNING'));
    assert.ok(warning.includes('Node 22') && warning.includes('Node 26'));
  });

  it('is silent without a comparable image version', () => {
    assert.equal(nodeMajorWarning('v22.0.0', undefined), undefined);
    assert.equal(nodeMajorWarning('v22.0.0', 'lts'), undefined);
  });
});
