# Voice character assets

Generated using the built-in imagegen tool on 2026-09-13 for the Qianshou voice companion. These are pre-rendered CG images, not a rigged 3D model or an identity of a real person.

- `voice-assistant-cg-v1.png`: base portrait; keep the original face and pose stationary.
- `voice-assistant-mouths-v1.png`: 2 by 2 mouth reference sheet, closed / A / O / E. Retired portrait prototype reference, retained only for old open pages and design provenance. The active character uses the VRM asset and does not use this sprite sheet.

## Final mouth-sheet edit prompt

Use case: identity-preserve.
Asset type: a precise four-frame speech-animation sprite sheet for an existing CG virtual assistant, one square sheet in a perfectly regular 2 by 2 grid, with no gutters, no borders, no writing.
Input image 1 is the EDIT TARGET. Duplicate the exact reference portrait in all four equal square cells. Preserve absolutely the same character identity, camera framing, scale, slightly tilted head angle, position of nose/eyes/chin, hair, clothing, lighting, background, skin tone, beautiful high-end game cinematic CG rendering. Each cell should contain the entire original square portrait, edge to edge, aligned identically. Do NOT straighten the head or change the expression of the eyes.
Change only the lips and immediately surrounding skin/lower jaw as necessary for restrained natural speech:
TOP LEFT: original gently closed lips, neutral pleasant listening expression, exact reference.
TOP RIGHT: lightly open A speaking phoneme, restrained aperture, natural small glimpse of upper teeth and dark mouth interior.
BOTTOM LEFT: small rounded O speaking phoneme, slightly pursed lips, tiny rounded dark opening.
BOTTOM RIGHT: lightly spread E speaking phoneme with a small opening and modest glimpse of teeth.
These are subtle natural conversation mouth shapes, not singing, not laughing, no exaggerated open mouth. Keep the mouth center and nose-chin alignment fixed across frames. Identical appearance outside the immediate mouth/lower-jaw region is critical for clean crossfaded animation. No extra objects, text, labels, watermarks.


## Interactive model

`voice-companion.vrm` is the unmodified `VRM1_Constraint_Twist_Sample` v1.0.1 by pixiv Inc., copyright (c) 2022 pixiv Inc. It comes from the official vrm-specification sample at commit `821c11b250d8c70d5804ee13431e42bee56ea9c0`.

- Source: https://github.com/vrm-c/vrm-specification/tree/821c11b250d8c70d5804ee13431e42bee56ea9c0/samples/VRM1_Constraint_Twist_Sample
- SHA-256: `12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2`
- License: https://vrm.dev/licenses/1.0/ with the embedded model permissions preserved. Redistribution and modification redistribution are permitted; commercial usage includes corporations. Antisocial or hate usage is not permitted.
- This licensed sample provides the working humanoid rig, expression morphs, eyes and spring-bone hair. It is a functional character and does not reproduce the generated CG reference's face or material quality.
- Generated portrait and mouth-sheet assets above remain reference/prototype material; they are not a substitute for the live 3D renderer.
