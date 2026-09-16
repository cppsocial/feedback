from importlib.resources import files

NAMES = ("0001_initial.sql",)


def scripts() -> tuple[str, ...]:
    root = files(__package__)
    return tuple(root.joinpath(name).read_text(encoding="utf-8") for name in NAMES)
