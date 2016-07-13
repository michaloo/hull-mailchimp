import swal from "sweetalert";
import $ from "jquery";

alert('test');

$(function() {

  $("[data-confirm]").click(function() {
    var listName = $(this).attr('data-confirm');
    var actionUrl = $(this).attr('data-action');
    swal({
      title: "Sync all users and segments",
      text: "You are going to resync Mailchimp with Hull. This will empty the list you picked ("
        + listName + "). This can generate a lot of traffic. Are you sure?",
      type: "warning",
      showCancelButton: true,
      confirmButtonColor: "#DD6B55",
      confirmButtonText: "Yes, sync it!",
      closeOnConfirm: false
    }, function(isConfirm) {
      if (isConfirm) {
        $.post(actionUrl);
        swal("Sync started", "The Mailchimp list ("
        + listName + ") will be synced shortly.", "success");
      }
    });
  });
});
