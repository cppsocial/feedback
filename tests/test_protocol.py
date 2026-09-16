import pytest
from starlette.datastructures import QueryParams

from feedback.api.http import ApiError, resource_keys


def test_resource_query_is_canonicalized() -> None:
    assert resource_keys(QueryParams("keys=b,a,b"), 10) == ["a", "b"]


@pytest.mark.parametrize(
    "query",
    ["", "keys=a&keys=b", "keys=a&extra=b", "key=a", "keys=", "keys=../a"],
)
def test_resource_query_rejects_ambiguous_input(query: str) -> None:
    with pytest.raises(ApiError):
        resource_keys(QueryParams(query), 10)
