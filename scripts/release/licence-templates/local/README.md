# Local licence templates

Variants that SPDX's list (the folder above) doesn't carry as their own templates, each derived from
the SPDX template it names, with the one change written out:

- `BSD-2-Clause-unchanged.template.txt`: SPDX's `BSD-2-Clause` with clause 1 ending "the following
  disclaimer in this position and unchanged.", the wording libarchive's `COPYING` uses (as FreeBSD
  code does).
- `BSD-3-Clause-named.template.txt`: SPDX's `BSD-3-Clause` whose clause 3 pattern also allows
  "Neither the name <names>, nor the names of its contributors may", without "of" after "name", as
  zstd's `LICENSE` reads ("Neither the name Facebook, nor Meta, nor the names of its contributors
  may"). Every word of the clause is still required.
