import { compileAll } from '@config/src/views/compile-eta.js';

export default async function setup(): Promise<void> {
  await compileAll();
}
