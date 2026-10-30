import { createHash } from 'node:crypto';

// SHA-256 of every SKILL.md and references/usage.md this package has ever bundled.
// Init treats an installed file whose hash is listed as an unmodified bundled copy
// and upgrades or removes it; any other content is a user edit and is preserved.
// test/skill.test.mjs fails when the current skills/lambdadb/SKILL.md is missing, so
// every change to the bundled skill adds its hash here before release.
const bundledSkills = new Set([
  '114d174fe540f10e7afb73458cddcf60c73ddb80850436bb9252df3d1fa66b24',
  '4326662e0720fbeaab83d298b34c889581f951ffdd55f5886deae51267129afc',
  '0085b9355e0211394992113f087226af586217f5edaabda75459ceeb94eb230b',
  '43e90c5959df842a640019b74fb26b9ae6610edc749fa311ead3129b47dc1465',
  '25f048001cd5ed3ec52b33c533be4888a5b603a9e3b9008761bcd80ad72fe546', // 0.1.7
  'd09c0c2ddc948630a3b8d3e201dced3974e259475434287070302639a73b9656',
  'e9d0b28d996172f6129f59051698968ad650d2085f607e4d2c01fbba939067af',
]);

// references/usage.md shipped with 0.1.7 and earlier; the skill is a single file now.
const bundledReferences = new Set([
  '6bc09d41f6f02018d2a13eec2e5ec1522f5684ae018f961de6174615f6709a36',
  '88678f72d8515b7516b7b50f564de60f08780fe70b526a24378c0098c18164cd',
  'cf9eb1ce17fb826702306c66b74280d513d00c137ddfcea1fffb6ecbc61f58b3',
  '98c5be44f383acd85f3d27f99bc87641ce85895c9d9c2a481bddde28ca317cf9', // 0.1.7
]);

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const isBundledSkill = (text: string) => bundledSkills.has(sha256(text));
export const isBundledReference = (text: string) => bundledReferences.has(sha256(text));
