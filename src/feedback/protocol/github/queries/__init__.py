from importlib.resources import files


def load(name: str) -> str:
    return files(__package__).joinpath(f"{name}.graphql").read_text(encoding="utf-8")
