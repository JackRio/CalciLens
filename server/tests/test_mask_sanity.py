import numpy as np
import pytest

from volume_store import MAX_MASK_LABELS, _assert_looks_like_mask


def test_label_masks_pass():
    _assert_looks_like_mask(np.unique(np.array([0, 1, 2, 3], dtype=np.uint8)))
    # Whole-heart masks with large label values must still pass.
    _assert_looks_like_mask(np.unique(np.array([0, 205, 420, 850], dtype=np.int16)))
    _assert_looks_like_mask(np.unique(np.array([0.0, 1.0, 2.0], dtype=np.float32)))


@pytest.mark.parametrize(
    "values",
    [
        np.array([-1024, 0, 40, 300], dtype=np.int16),  # a CT: air is negative
        np.array([0.0, 0.5, 1.0], dtype=np.float32),  # fractional values
        np.arange(MAX_MASK_LABELS + 1, dtype=np.int32),  # too many distinct values
    ],
)
def test_images_are_refused(values):
    with pytest.raises(ValueError, match="not a segmentation"):
        _assert_looks_like_mask(np.unique(values))
