"""CDM types. Every normalizer produces a CanonicalDocument; the chunker
consumes one. Pydantic Field(default_factory=...) is mandatory for any
mutable default — raw `dict = {}` shares state across instances."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

BlockType = Literal["paragraph", "heading", "list_item", "quote", "code"]


class Block(BaseModel):
    id: str
    type: BlockType
    section_path: str
    text: str
    metadata: dict = Field(default_factory=dict)


class Section(BaseModel):
    path: str
    title: Optional[str] = None
    children: list["Section"] = Field(default_factory=list)


class CanonicalDocument(BaseModel):
    document_id: str
    version_id: str
    title: Optional[str] = None
    blocks: list[Block] = Field(default_factory=list)
    section_index: list[Section] = Field(default_factory=list)


Section.model_rebuild()
