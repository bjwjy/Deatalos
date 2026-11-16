import { checkSourceQuality } from '../project/source-quality.mjs';
const result = await checkSourceQuality();
console.log(JSON.stringify(result, null, 2));
if (result.issues.length) process.exitCode = 1;
