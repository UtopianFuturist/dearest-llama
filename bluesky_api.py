import requests
import typing

BASE_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"

def get_user_posts(actor_did: str, limit: int = 50, filter_mode: str = "posts_with_replies") -> typing.List[typing.Dict[str, typing.Any]]:
    """
    Fetches a user's posts and replies from Bluesky.

    Args:
        actor_did: The DID (Decentralized Identifier) or handle of the user.
        limit: The number of posts to retrieve per request (1-100, default 50).
        filter_mode: Determines the types of posts to include.
                     Options: 'posts_with_replies', 'posts_no_replies',
                              'posts_with_media', 'posts_and_author_threads',
                              'posts_with_video'.
                     Default is 'posts_with_replies'.

    Returns:
        A list of posts, where each post is a dictionary.
        Returns an empty list if an error occurs or no posts are found.
    """
    all_posts = []
    cursor = None

    # Validate limit
    if not 1 <= limit <= 100:
        print("Error: Limit must be between 1 and 100.")
        return []

    params = {
        "actor": actor_did,
        "limit": limit,
        "filter": filter_mode,
    }

    try:
        while True:
            if cursor:
                params["cursor"] = cursor

            response = requests.get(BASE_URL, params=params)
            response.raise_for_status()  # Raises an HTTPError for bad responses (4XX or 5XX)

            data = response.json()
            posts = data.get("feed", [])
            all_posts.extend(posts)

            cursor = data.get("cursor")
            if not cursor or not posts:  # No more pages or no posts in the current page
                break

        return all_posts

    except requests.exceptions.RequestException as e:
        print(f"Error fetching posts for {actor_did}: {e}")
        return []
    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        return []

if __name__ == '__main__':
    # --- Example Usage & Basic Test ---
    print("--- Bluesky User Post Fetcher ---")
    print("This script allows you to fetch posts and replies for a given Bluesky user DID.")

    # Example 1: Using a known public DID (e.g., Bluesky official account)
    # did:plc:z72i7hdynmk6r22z27h6tvur is bsky.app team account
    # did:plc:jcsq45f6wgv3e25z4wdommmz is jay.bsky.team (Jay Graber, CEO)
    # did:plc:vxo2oqpz7y6z7x5gwk3r2qwb is why.bsky.team (Paul Frazee)
    test_did_official = "did:plc:z72i7hdynmk6r22z27h6tvur"
    print(f"\nAttempting to fetch posts for a known public DID: {test_did_official} (bsky.app team)")

    # Test with a small limit for demonstration
    # We expect this to succeed and return posts if the account is active and public.
    user_posts = get_user_posts(test_did_official, limit=5)

    if user_posts:
        print(f"Successfully fetched {len(user_posts)} posts/replies for {test_did_official}.")
        for i, item in enumerate(user_posts):
            post_record = item.get('post', {}).get('record', {})
            post_text = post_record.get('text', 'N/A')
            post_uri = item.get('post', {}).get('uri', 'N/A')

            print(f"\n  Post {i+1} (URI: {post_uri}):")
            print(f"    Text: {post_text[:100]}...") # Print first 100 chars

            reply_info = item.get('reply')
            if reply_info:
                parent_author_handle = reply_info.get('parent', {}).get('author', {}).get('handle', 'N/A')
                print(f"    This is a reply to a post by: {parent_author_handle}")
                # print(f"    Parent post URI: {reply_info.get('parent', {}).get('uri')}")
                # print(f"    Root post URI: {reply_info.get('root', {}).get('uri')}")

        # Test pagination briefly by trying to get more if possible
        if len(user_posts) == 5: # If we got the limit, there might be more
            print(f"\nAttempting to fetch more posts (testing pagination) for {test_did_official} with a total limit of 7...")
            more_posts = get_user_posts(test_did_official, limit=7) # Try fetching slightly more
            if len(more_posts) > 5:
                 print(f"Successfully fetched {len(more_posts)} posts, indicating pagination likely worked.")
            elif len(more_posts) == 5:
                 print(f"Fetched {len(more_posts)} posts again. The user might have only {len(more_posts)} posts or fewer than 7.")
            else:
                 print("Could not fetch more posts or fewer posts than initial fetch.")

    else:
        print(f"No posts found for {test_did_official}, or an error occurred during fetching.")
        print("This could be due to network issues, API changes, or if the account has no posts.")

    # Example 2: Testing with an invalid DID format (illustrative, won't make API call if format is clearly bad)
    # but the API itself would return an error for a non-existent or malformed DID.
    # The current code relies on the API to return an error for invalid DIDs.
    test_invalid_did = "did:plc:thisisnotarealdid12345"
    print(f"\nAttempting to fetch posts for an invalid DID: {test_invalid_did}")
    invalid_posts = get_user_posts(test_invalid_did, limit=5)
    if not invalid_posts:
        print(f"Correctly received no posts for invalid DID {test_invalid_did} (as expected, API should error).")
    else:
        print(f"Unexpectedly received {len(invalid_posts)} posts for invalid DID {test_invalid_did}.")

    print("\n--- End of Examples/Tests ---")
    print("To test with your own DIDs, modify the 'test_did_official' variable or call get_user_posts() directly.")
