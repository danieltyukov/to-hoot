#!/usr/bin/env python3
"""Renames a font family in place, so a subset never ships under a reserved name.

Every name ID that can carry the family has to change, not just the one a font
manager shows: leaving nameID 6 or the variable-instance names on the upstream
value is still distributing a modified font under the name the OFL reserves.
"""

import sys

from fontTools.ttLib import TTFont


def rename(path: str, family: str) -> None:
    compact = family.replace(" ", "").replace("-", "")
    font = TTFont(path)
    name = font["name"]

    # Names the variable instances point at, so they are not rewritten as if
    # they were family names: "Regular" must stay "Regular".
    instance_ids = set()
    if "fvar" in font:
        instance_ids = {i.subfamilyNameID for i in font["fvar"].instances}
        instance_ids |= {a.axisNameID for a in font["fvar"].axes}

    for record in list(name.names):
        nid = record.nameID
        if nid in instance_ids:
            continue
        args = (record.platformID, record.platEncID, record.langID)
        if nid in (1, 16, 21):  # family, typographic family, WWS family
            name.setName(family, nid, *args)
        elif nid == 3:  # unique id
            name.setName(f"{family};to-hoot", nid, *args)
        elif nid == 4:  # full name
            name.setName(family, nid, *args)
        elif nid == 6:  # postscript name
            name.setName(f"{compact}-Regular", nid, *args)
        elif nid == 25:  # variations postscript name prefix
            name.setName(compact, nid, *args)

    font.save(path)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: rename-font.py <font.ttf> <new family name>", file=sys.stderr)
        raise SystemExit(2)
    rename(sys.argv[1], sys.argv[2])
