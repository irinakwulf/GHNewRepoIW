"""Tests for ``a_cust_test_feature`` and the unchanged ``submod.py`` baseline.

The suite proves the contract of the root module ``a_cust_test_feature``:

* ``aCustTestFeature.number2026721`` prints the integers 1 to 10, one per line.
* ``aCustTestFeature.tebahpla2026721`` prints the lowercase alphabet reversed.
* ``aCustTestFeature.oneWeek2026721`` prints the date seven days after today,
  checked against a fixed clock so no test depends on the real date.
* ``aTestFeature`` is the same class object, every method is a static method,
  and the module's public names are exactly ``aCustTestFeature`` and
  ``aTestFeature``.

It also pins the behaviour of the existing ``submod.py``: its script output,
its public surface and the silence of importing it, all observed in child
interpreters so module caching in the test runner cannot mask any output.

Every output check captures standard output and compares the complete text;
an exit status alone is never taken as proof of what a method printed.

Run from the repository root (``-s tests`` is required because ``tests/`` is
not a package)::

    python -B -m unittest discover -s tests -v --buffer
"""

import contextlib
import datetime
import inspect
import io
import os
import subprocess
import sys
import unittest
from unittest import mock

# The repository root is the parent of ``tests/``. Putting it first on
# ``sys.path`` lets the first-party import below resolve whatever the current
# working directory is, and gives child interpreters a fixed ``cwd``.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

import a_cust_test_feature  # noqa: E402
from a_cust_test_feature import aCustTestFeature, aTestFeature  # noqa: E402

# Exact text ``tebahpla2026721`` prints, shared by the two tests that call it.
ALPHABET_REVERSED = 'zyxwvutsrqponmlkjihgfedcba\n'

# The three user-named methods, verbatim, in the order the request lists them.
METHOD_NAMES = ('number2026721', 'tebahpla2026721', 'oneWeek2026721')


def capture(fn):
    """Call ``fn()`` with standard output redirected and return what it wrote.

    Returns a ``(text, result)`` tuple: ``text`` is everything written to
    ``sys.stdout`` during the call and ``result`` is ``fn``'s return value.
    The redirection is undone when the call returns or raises.
    """
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        result = fn()
    return buffer.getvalue(), result


def fixed_date(value):
    """Return a ``datetime.date`` subclass whose ``today()`` returns ``value``.

    The class replaces the module-level ``date`` name in
    ``a_cust_test_feature`` (its clock seam) through ``mock.patch.object``.
    Only ``today()`` is overridden and ``value`` is a real ``datetime.date``,
    so the production ``+ timedelta(weeks=1)`` and ``isoformat()`` still run
    on genuine ``datetime.date`` arithmetic.
    """

    class FixedDate(datetime.date):
        """``datetime.date`` whose ``today()`` always returns a fixed date."""

        @classmethod
        def today(cls):
            return value

    return FixedDate


def run_child(*args):
    """Run this interpreter with ``-B`` and ``args`` in the repository root.

    ``sys.executable`` is the interpreter running this suite, so the child
    uses the same isolated environment. ``-B`` stops the child writing
    ``__pycache__`` into the checkout. Output stays as bytes so tests compare
    it exactly, and no ``check`` is passed so each test asserts the exit
    status itself. Returns the ``subprocess.CompletedProcess``.
    """
    return subprocess.run(
        [sys.executable, '-B', *args],
        cwd=REPO_ROOT,
        capture_output=True,
    )


class TestNumber2026721(unittest.TestCase):
    """``number2026721`` prints 1 to 10 inclusive, one value per line."""

    def test_prints_one_to_ten_one_per_line(self):
        output, result = capture(aCustTestFeature.number2026721)
        self.assertEqual(output, '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n')
        self.assertIsNone(result)


class TestTebahpla2026721(unittest.TestCase):
    """``tebahpla2026721`` prints the lowercase alphabet ``z`` to ``a``."""

    def test_prints_lowercase_alphabet_reversed_on_one_line(self):
        output, result = capture(aCustTestFeature.tebahpla2026721)
        self.assertEqual(output, ALPHABET_REVERSED)
        self.assertIsNone(result)


class TestOneWeek2026721(unittest.TestCase):
    """``oneWeek2026721`` prints today plus seven days as ``YYYY-MM-DD``.

    Each test fixes "today" by patching the module's clock seam, so the
    result never depends on the real clock or on when the suite runs.
    """

    def assert_one_week_after(self, today, expected):
        """Assert the output is ``expected`` when the clock reads ``today``."""
        with mock.patch.object(a_cust_test_feature, 'date', fixed_date(today)):
            output, result = capture(aCustTestFeature.oneWeek2026721)
        self.assertEqual(output, expected)
        self.assertIsNone(result)

    def test_prints_date_seven_days_after_today(self):
        self.assert_one_week_after(datetime.date(2026, 10, 5), '2026-10-12\n')

    def test_crosses_month_boundary(self):
        self.assert_one_week_after(datetime.date(2026, 10, 28), '2026-11-04\n')

    def test_crosses_year_boundary(self):
        self.assert_one_week_after(datetime.date(2026, 12, 28), '2027-01-04\n')

    def test_crosses_leap_february(self):
        self.assert_one_week_after(datetime.date(2028, 2, 25), '2028-03-03\n')


class TestClassSurface(unittest.TestCase):
    """The alias, the method kinds and the module's public names."""

    def test_atestfeature_is_the_same_class(self):
        self.assertIs(aTestFeature, aCustTestFeature)

    def test_methods_are_static_and_callable_from_instance(self):
        for name in METHOD_NAMES:
            with self.subTest(name=name):
                self.assertIsInstance(
                    inspect.getattr_static(aCustTestFeature, name),
                    staticmethod,
                )
        output, result = capture(aTestFeature().tebahpla2026721)
        self.assertEqual(output, ALPHABET_REVERSED)
        self.assertIsNone(result)

    def test_public_names(self):
        self.assertEqual(
            a_cust_test_feature.__all__,
            ['aCustTestFeature', 'aTestFeature'],
        )


class TestExistingBehaviourUnchanged(unittest.TestCase):
    """Import silence and the ``submod.py`` baseline, seen in child processes.

    ``submod`` is never imported into this process; each check starts a fresh
    interpreter in the repository root and compares its exact output.
    """

    def test_imports_produce_no_output(self):
        completed = run_child('-c', 'import a_cust_test_feature, submod')
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b'')
        self.assertEqual(completed.stderr, b'')

    def test_submod_script_output_unchanged(self):
        completed = run_child('submod.py')
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b'Hello Blitzy User, From Wulf 2\n')
        self.assertEqual(completed.stderr, b'')

    def test_submod_public_surface_unchanged(self):
        completed = run_child(
            '-c',
            'import submod; '
            "print([n for n in dir(submod) if not n.startswith('__')])",
        )
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b"['print_hi']\n")
        self.assertEqual(completed.stderr, b'')


if __name__ == '__main__':
    unittest.main()
