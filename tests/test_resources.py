import pytest

from feedback.service.resources import (
    Resource,
    ResourceError,
    lookup_term,
    validate_resource_id,
)


@pytest.mark.parametrize("value", ["book", "books/cpp-concurrency", "a.b_c~d-e"])
def test_valid_resource_ids(value: str) -> None:
    assert validate_resource_id(value) == value


@pytest.mark.parametrize("value", ["", "/book", "book/", "../book", "book//edition", "book?q=1"])
def test_invalid_resource_ids(value: str) -> None:
    with pytest.raises(ResourceError):
        validate_resource_id(value)


@pytest.mark.parametrize(
    ("mapping", "resource", "expected"),
    [
        ("key", Resource("book"), "book"),
        ("title", Resource("book", title=" A Book "), "A Book"),
        (
            "url",
            Resource("book", url="https://cpp.social/books/a"),
            "https://cpp.social/books/a",
        ),
        ("pathname", Resource("book", url="https://cpp.social/books/a"), "/books/a"),
        ("custom", Resource("book", custom="feedback:book"), "feedback:book"),
        ("number", Resource("book", number=42), "42"),
    ],
)
def test_mapping_schemes(mapping: str, resource: Resource, expected: str) -> None:
    assert lookup_term(mapping, resource) == expected
