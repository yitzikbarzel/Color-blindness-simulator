# DaltonLens reference images

`input.png` and the `brettel1997_*_wn_*.png` images are the reference images from
[libDaltonLens](https://github.com/DaltonLens/libDaltonLens) (`tests/images`),
released into the public domain (Unlicense). They were produced by
DaltonLens-Python, which is itself validated against external references.

`golden.test.js` and the end-to-end suite require our Brettel 1997 output to
match them within 1 unit per channel — the same tolerance libDaltonLens uses.

SHA-256 of `input.png`: `84e957ee35c56adfb9f5857897411336615cab5c36322826f84df88d40fa2aea`
(matches the Git LFS pointer in the upstream repository).
