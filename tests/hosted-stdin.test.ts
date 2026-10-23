import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { prepareHostedStdin } from '@/lib/hosted-stdin';

describe('managed hosting stdin',()=>{
  it('leaves a normal terminal or worker input unchanged',()=>{
    const stdin=Readable.from(['input']);const target={stdin} as Pick<NodeJS.Process,'stdin'>;
    expect(prepareHostedStdin(target)).toBe(false);expect(target.stdin).toBe(stdin);
  });
  it('replaces only the failing stdin getter without closing the hosting socket',async()=>{
    const target=Object.defineProperty({},'stdin',{configurable:true,enumerable:true,get(){throw Object.assign(new Error('open EEXIST'),{code:'EEXIST',syscall:'open'});}}) as Pick<NodeJS.Process,'stdin'>;
    expect(prepareHostedStdin(target)).toBe(true);
    // Node enumerates getters when constructing the node:process ESM facade.
    expect(()=>Object.fromEntries(Object.entries(target))).not.toThrow();
    const chunks=[];for await(const chunk of target.stdin)chunks.push(chunk);expect(chunks).toEqual([]);
    expect(prepareHostedStdin(target)).toBe(false);
  });
  it('does not hide unrelated input or filesystem errors',()=>{
    const failure=Object.assign(new Error('open EACCES'),{code:'EACCES',syscall:'open'});
    const target=Object.defineProperty({},'stdin',{get(){throw failure;}}) as Pick<NodeJS.Process,'stdin'>;
    expect(()=>prepareHostedStdin(target)).toThrow(failure);
  });
});
