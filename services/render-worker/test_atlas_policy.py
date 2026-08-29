from atlas_policy import atlas_resolution

passed = failed = 0


def ok(name, condition):
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}")


ok("a small room uses a 1024 atlas", atlas_resolution(5) == 1024)
ok("sixteen meshes still fit 1024", atlas_resolution(16) == 1024)
ok("seventeen meshes step up to 2048", atlas_resolution(17) == 2048)
ok("sixty-four meshes fit 2048", atlas_resolution(64) == 2048)
ok("a 158-mesh villa steps up to 4096", atlas_resolution(158) == 4096)
ok("the single-atlas ceiling is 256 meshes", atlas_resolution(256) == 4096)

try:
    atlas_resolution(257)
    too_many_refused = False
except ValueError as error:
    too_many_refused = "capacity is 256" in str(error)
ok("excess geometry is explicitly refused", too_many_refused)

try:
    atlas_resolution(10, maximum=3000)
    bad_max_refused = False
except ValueError:
    bad_max_refused = True
ok("a non-power-of-two memory ceiling is refused", bad_max_refused)

try:
    atlas_resolution(0)
    empty_refused = False
except ValueError:
    empty_refused = True
ok("an empty mesh count is refused", empty_refused)

print(f"\n{passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
