import { hc, type InferRequestType, type InferResponseType } from "hono/client";
import { describe, expectTypeOf, it } from "vitest";
import type {
  Attachment,
  AttachmentList,
  BacklinkList,
  CreateFolderRequest,
  CreatePageRequest,
  CreateSpaceRequest,
  CreateUserRequest,
  Folder,
  FolderList,
  MoveFolderRequest,
  MovePageRequest,
  Page,
  PageList,
  PageRevision,
  PageRevisionList,
  PageSummary,
  RestorePageRevisionRequest,
  SearchHit,
  SearchResult,
  SetSpaceMembersRequest,
  SetTopPageRequest,
  Space,
  SpaceList,
  SpaceMembers,
  TopPage,
  TrashedPage,
  TrashList,
  UpdateFolderRequest,
  UpdatePageRequest,
  User,
  UserList,
} from "../src/api/types";
import type { AppType } from "../src/index";
import { ORIGIN } from "./helpers";

// These assertions are checked by `pnpm typecheck`, not at runtime.
const client = hc<AppType>(ORIGIN);

type CreateUserJson = InferRequestType<typeof client.api.v1.users.$post>["json"];
type CreateSpaceJson = InferRequestType<typeof client.api.v1.spaces.$post>["json"];
type SetSpaceMembersJson = InferRequestType<(typeof client.api.v1.spaces)[":id"]["members"]["$put"]>["json"];
type CreatePageJson = InferRequestType<(typeof client.api.v1.spaces)[":id"]["pages"]["$post"]>["json"];
type UpdatePageJson = InferRequestType<(typeof client.api.v1.pages)[":id"]["$patch"]>["json"];
type CreateFolderJson = InferRequestType<(typeof client.api.v1.spaces)[":id"]["folders"]["$post"]>["json"];
type UpdateFolderJson = InferRequestType<(typeof client.api.v1.folders)[":id"]["$patch"]>["json"];
type MovePageJson = InferRequestType<(typeof client.api.v1.pages)[":id"]["move"]["$post"]>["json"];
type MoveFolderJson = InferRequestType<(typeof client.api.v1.folders)[":id"]["move"]["$post"]>["json"];
type SearchQuery = InferRequestType<typeof client.api.v1.search.$get>["query"];
type UploadAttachment = InferRequestType<(typeof client.api.v1.pages)[":id"]["attachments"]["$post"]>;
type SetTopPageJson = InferRequestType<(typeof client.api.v1)["top-page"]["$put"]>["json"];
type RestoreRevision = InferRequestType<
  (typeof client.api.v1.pages)[":id"]["revisions"][":version"]["restore"]["$post"]
>;

describe("AppType", () => {
  it("types the request body of POST /api/v1/users", () => {
    expectTypeOf<CreateUserJson>().toEqualTypeOf<CreateUserRequest>();
    const withoutName: CreateUserJson = { email: "a@example.com", password: "correct horse battery", role: "member" };
    // @ts-expect-error role must be admin or member
    const owner: CreateUserJson = { email: "a@example.com", password: "correct horse battery", role: "owner" };
    void withoutName;
    void owner;
  });

  it("types the request body of POST /api/v1/spaces", () => {
    expectTypeOf<CreateSpaceJson>().toEqualTypeOf<CreateSpaceRequest>();
    const everyone: CreateSpaceJson = { kind: "everyone", name: "Everyone" };
    const members: CreateSpaceJson = { kind: "members", name: "Team", member_ids: ["user-1"] };
    // @ts-expect-error personal spaces cannot be created through the API
    const personal: CreateSpaceJson = { kind: "personal", name: "Mine" };
    // @ts-expect-error member_ids is a list of user IDs
    const oneMember: CreateSpaceJson = { kind: "members", name: "Team", member_ids: "user-1" };
    void everyone;
    void members;
    void personal;
    void oneMember;
  });

  it("types the members of a space", () => {
    expectTypeOf<SetSpaceMembersJson>().toEqualTypeOf<SetSpaceMembersRequest>();
    expectTypeOf<
      InferResponseType<(typeof client.api.v1.spaces)[":id"]["members"]["$get"], 200>
    >().toEqualTypeOf<SpaceMembers>();
    expectTypeOf<
      InferResponseType<(typeof client.api.v1.spaces)[":id"]["members"]["$put"], 200>
    >().toEqualTypeOf<SpaceMembers>();
  });

  it("types the request bodies of page creation and update", () => {
    expectTypeOf<CreatePageJson>().toEqualTypeOf<CreatePageRequest>();
    expectTypeOf<UpdatePageJson>().toEqualTypeOf<UpdatePageRequest>();
    const titleOnly: UpdatePageJson = { version: 1, title: "Title" };
    // @ts-expect-error version is required for optimistic locking
    const withoutVersion: UpdatePageJson = { title: "Title" };
    void titleOnly;
    void withoutVersion;
  });

  it("types the request bodies of folder creation and update", () => {
    expectTypeOf<CreateFolderJson>().toEqualTypeOf<CreateFolderRequest>();
    expectTypeOf<UpdateFolderJson>().toEqualTypeOf<UpdateFolderRequest>();
    const topLevel: CreateFolderJson = { name: "Docs", parent_id: null };
    // @ts-expect-error name is required
    const withoutName: CreateFolderJson = { parent_id: null };
    const moveToTop: UpdateFolderJson = { parent_id: null };
    void topLevel;
    void withoutName;
    void moveToTop;
  });

  it("types the request bodies of the moves between spaces", () => {
    expectTypeOf<MovePageJson>().toEqualTypeOf<MovePageRequest>();
    expectTypeOf<MoveFolderJson>().toEqualTypeOf<MoveFolderRequest>();
    const pageToTop: MovePageJson = { version: 1, space_id: "s1", folder_id: null };
    // @ts-expect-error version is required for optimistic locking
    const pageWithoutVersion: MovePageJson = { space_id: "s1" };
    const folderToTop: MoveFolderJson = { space_id: "s1" };
    // @ts-expect-error space_id is required
    const folderWithoutSpace: MoveFolderJson = { parent_id: null };
    void pageToTop;
    void pageWithoutVersion;
    void folderToTop;
    void folderWithoutSpace;
  });

  it("types folder_id on pages and search hits", () => {
    expectTypeOf<PageSummary["folder_id"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Page["folder_id"]>().toEqualTypeOf<string | null>();
    expectTypeOf<SearchHit["folder_id"]>().toEqualTypeOf<string | null>();
    const moveToTop: UpdatePageJson = { version: 1, folder_id: null };
    void moveToTop;
  });

  it("types the query of GET /api/v1/search", () => {
    expectTypeOf<SearchQuery["q"]>().toEqualTypeOf<string>();
    const withSpace: SearchQuery = { q: "plan", space_id: "s1" };
    // @ts-expect-error q is required
    const withoutQ: SearchQuery = { space_id: "s1" };
    void withSpace;
    void withoutQ;
  });

  it("types the request of restoring a revision", () => {
    expectTypeOf<RestoreRevision["json"]>().toEqualTypeOf<RestorePageRevisionRequest>();
    const param: RestoreRevision["param"] = { id: "p1", version: "3" };
    // @ts-expect-error version is required for optimistic locking
    const withoutVersion: RestoreRevision["json"] = {};
    void param;
    void withoutVersion;
  });

  it("types successful response bodies", () => {
    expectTypeOf<InferResponseType<typeof client.api.v1.me.$get, 200>>().toEqualTypeOf<User>();
    expectTypeOf<InferResponseType<typeof client.api.v1.users.$get, 200>>().toEqualTypeOf<UserList>();
    expectTypeOf<InferResponseType<typeof client.api.v1.users.$post, 201>>().toEqualTypeOf<User>();
    expectTypeOf<InferResponseType<typeof client.api.v1.spaces.$get, 200>>().toEqualTypeOf<SpaceList>();
    expectTypeOf<InferResponseType<typeof client.api.v1.spaces.$post, 201>>().toEqualTypeOf<Space>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.spaces)[":id"]["pages"]["$get"], 200>>().toEqualTypeOf<PageList>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.spaces)[":id"]["pages"]["$post"], 201>>().toEqualTypeOf<Page>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.pages)[":id"]["$get"], 200>>().toEqualTypeOf<Page>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.pages)[":id"]["$patch"], 200>>().toEqualTypeOf<Page>();
    expectTypeOf<InferResponseType<typeof client.api.v1.search.$get, 200>>().toEqualTypeOf<SearchResult>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.spaces)[":id"]["folders"]["$get"], 200>>().toEqualTypeOf<FolderList>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.spaces)[":id"]["folders"]["$post"], 201>>().toEqualTypeOf<Folder>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.folders)[":id"]["$get"], 200>>().toEqualTypeOf<Folder>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.folders)[":id"]["$patch"], 200>>().toEqualTypeOf<Folder>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.pages)[":id"]["revisions"]["$get"], 200>>().toEqualTypeOf<PageRevisionList>();
    expectTypeOf<
      InferResponseType<(typeof client.api.v1.pages)[":id"]["revisions"][":version"]["$get"], 200>
    >().toEqualTypeOf<PageRevision>();
    expectTypeOf<
      InferResponseType<(typeof client.api.v1.pages)[":id"]["revisions"][":version"]["restore"]["$post"], 200>
    >().toEqualTypeOf<Page>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.spaces)[":id"]["trash"]["$get"], 200>>().toEqualTypeOf<TrashList>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.pages)[":id"]["restore"]["$post"], 200>>().toEqualTypeOf<Page>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.pages)[":id"]["move"]["$post"], 200>>().toEqualTypeOf<Page>();
    expectTypeOf<InferResponseType<(typeof client.api.v1.folders)[":id"]["move"]["$post"], 200>>().toEqualTypeOf<Folder>();
  });

  it("types the attachments", () => {
    expectTypeOf<UploadAttachment["query"]>().toEqualTypeOf<{ filename: string }>();
    // @ts-expect-error filename is required
    const withoutFilename: UploadAttachment["query"] = {};
    void withoutFilename;
    expectTypeOf<
      InferResponseType<(typeof client.api.v1.pages)[":id"]["attachments"]["$post"], 201>
    >().toEqualTypeOf<Attachment>();
    expectTypeOf<
      InferResponseType<(typeof client.api.v1.pages)[":id"]["attachments"]["$get"], 200>
    >().toEqualTypeOf<AttachmentList>();
    const param: InferRequestType<(typeof client.api.v1.attachments)[":id"]["$delete"]>["param"] = { id: "a1" };
    void param;
  });

  it("types the links to a page", () => {
    expectTypeOf<
      InferResponseType<(typeof client.api.v1.pages)[":id"]["backlinks"]["$get"], 200>
    >().toEqualTypeOf<BacklinkList>();
  });

  it("types the deletion of a user", () => {
    expectTypeOf<UserList["auth_mode"]>().toEqualTypeOf<"oidc" | "password">();
    const param: InferRequestType<(typeof client.api.v1.users)[":id"]["$delete"]>["param"] = { id: "u1" };
    // @ts-expect-error id is required
    const withoutId: InferRequestType<(typeof client.api.v1.users)[":id"]["$delete"]>["param"] = {};
    void param;
    void withoutId;
  });

  it("types the top page", () => {
    expectTypeOf<SetTopPageJson>().toEqualTypeOf<SetTopPageRequest>();
    expectTypeOf<InferResponseType<(typeof client.api.v1)["top-page"]["$get"], 200>>().toEqualTypeOf<TopPage>();
    expectTypeOf<InferResponseType<(typeof client.api.v1)["top-page"]["$put"], 200>>().toEqualTypeOf<TopPage>();
    const clear: SetTopPageJson = { page_id: null };
    // @ts-expect-error page_id is required
    const withoutPageId: SetTopPageJson = {};
    void clear;
    void withoutPageId;
  });

  it("types the trash", () => {
    expectTypeOf<TrashedPage["deleted_at"]>().toEqualTypeOf<number>();
    expectTypeOf<TrashedPage["deleted_by"]>().toEqualTypeOf<string | null>();
    expectTypeOf<TrashedPage["purge_after"]>().toEqualTypeOf<number>();
    const param: InferRequestType<(typeof client.api.v1.pages)[":id"]["permanent"]["$delete"]>["param"] = { id: "p1" };
    void param;
  });
});
