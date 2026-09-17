import pytest

from feedback.service.oauth_state import (
    CreationGrantSigner,
    GrantError,
    StateError,
    StateSigner,
    pkce_challenge,
)

VERIFIER = "v" * 43
NONCE = "n" * 22


def test_signed_state_round_trip() -> None:
    signer = StateSigner(b"k" * 32, clock=lambda: 1_000)
    token = signer.issue(
        site="cpp-social",
        origin="https://cpp.social",
        challenge=pkce_challenge(VERIFIER),
        nonce=NONCE,
    )

    state = signer.verify(
        token,
        site="cpp-social",
        origin="https://cpp.social",
        verifier=VERIFIER,
    )

    assert state.nonce == NONCE
    assert state.expires_at == 1_300


@pytest.mark.parametrize("change", ["signature", "site", "origin", "verifier"])
def test_signed_state_rejects_tampering_and_binding_changes(change: str) -> None:
    signer = StateSigner(b"k" * 32, clock=lambda: 1_000)
    token = signer.issue(
        site="cpp-social",
        origin="https://cpp.social",
        challenge=pkce_challenge(VERIFIER),
        nonce=NONCE,
    )
    if change == "signature":
        token = token[:-1] + ("A" if token[-1] != "A" else "B")

    with pytest.raises(StateError):
        signer.verify(
            token,
            site="other" if change == "site" else "cpp-social",
            origin="https://other.example" if change == "origin" else "https://cpp.social",
            verifier="x" * 43 if change == "verifier" else VERIFIER,
        )


def test_signed_state_expires() -> None:
    now = 1_000
    signer = StateSigner(b"k" * 32, clock=lambda: now)
    token = signer.issue(
        site="cpp-social",
        origin="https://cpp.social",
        challenge=pkce_challenge(VERIFIER),
        nonce=NONCE,
    )
    now = 1_301

    with pytest.raises(StateError, match="expired"):
        signer.verify(token, site="cpp-social", origin="https://cpp.social", verifier=VERIFIER)


def test_creation_grant_matches_login_lifetime_and_is_origin_bound() -> None:
    now = 1_000
    signer = CreationGrantSigner(b"k" * 32, clock=lambda: now)
    grant = signer.issue(site="cpp-social", origin="https://cpp.social", nonce=NONCE)

    signer.verify(grant, site="cpp-social", origin="https://cpp.social")
    with pytest.raises(GrantError):
        signer.verify(grant, site="cpp-social", origin="https://other.example")
    now = 1_301
    signer.verify(grant, site="cpp-social", origin="https://cpp.social")
    now = 1_000 + 8 * 60 * 60 + 1
    with pytest.raises(GrantError):
        signer.verify(grant, site="cpp-social", origin="https://cpp.social")
